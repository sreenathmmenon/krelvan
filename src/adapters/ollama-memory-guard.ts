import { freemem, totalmem } from "node:os";
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { ExpectedError } from "../core/errors.js";

const DEFAULT_LIMIT_PERCENT = 85;
const MAX_LIMIT_PERCENT = 85;
const MODEL_HEADROOM_NUMERATOR = 5;
const MODEL_HEADROOM_DENOMINATOR = 4;

interface OllamaModel {
  name?: string;
  model?: string;
  size?: number;
}

export interface OllamaMemoryProbe {
  baseUrl: string;
  model: string;
  limitPercent?: number;
  totalBytes?: number;
  freeBytes?: number;
  fetchImpl?: typeof fetch;
}

export interface OllamaMemoryReport {
  limitPercent: number;
  currentPercent: number;
  projectedPercent: number;
  modelBytesAdded: number;
  alreadyLoaded: boolean;
}

function modelNamesMatch(left: string, right: string): boolean {
  const normalize = (name: string) => name.includes(":") ? name : `${name}:latest`;
  return normalize(left) === normalize(right);
}

function memoryLimit(requested?: number): number {
  const configured = requested ?? Number(process.env["KRELVAN_OLLAMA_MEMORY_LIMIT_PERCENT"] ?? DEFAULT_LIMIT_PERCENT);
  if (!Number.isFinite(configured) || configured <= 0) {
    throw new ExpectedError(
      "Ollama memory limit must be a number between 1 and 85.",
      "OLLAMA_MEMORY_LIMIT_INVALID",
    );
  }
  return Math.min(configured, MAX_LIMIT_PERCENT);
}

async function hostMemory(): Promise<{ totalBytes: number; freeBytes: number }> {
  const totalBytes = totalmem();
  if (process.platform === "darwin") {
    try {
      const stdout = await new Promise<string>((resolve, reject) => {
        execFile("/usr/bin/memory_pressure", ["-Q"], { timeout: 2_000 }, (error, value) => {
          if (error) reject(error);
          else resolve(value);
        });
      });
      const match = /System-wide memory free percentage:\s*(\d+(?:\.\d+)?)%/i.exec(stdout);
      const freePercent = Number(match?.[1]);
      if (Number.isFinite(freePercent) && freePercent >= 0 && freePercent <= 100) {
        return { totalBytes, freeBytes: totalBytes * freePercent / 100 };
      }
    } catch {
      // Fall back to the portable Node reading below.
    }
  }
  if (process.platform === "linux") {
    try {
      const info = await readFile("/proc/meminfo", "utf8");
      const availableKiB = Number(/^MemAvailable:\s+(\d+)\s+kB$/m.exec(info)?.[1]);
      if (Number.isFinite(availableKiB) && availableKiB >= 0) {
        return { totalBytes, freeBytes: availableKiB * 1024 };
      }
    } catch {
      // Fall back to the portable Node reading below.
    }
  }
  return { totalBytes, freeBytes: freemem() };
}

async function readJson(fetchImpl: typeof fetch, url: string): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetchImpl(url, { signal: AbortSignal.timeout(5_000) });
  } catch (error) {
    throw new ExpectedError(
      `Ollama memory preflight could not reach ${url}: ${(error as Error).message}`,
      "OLLAMA_MEMORY_PREFLIGHT_FAILED",
    );
  }
  if (!response.ok) {
    throw new ExpectedError(
      `Ollama memory preflight received HTTP ${response.status} from ${url}.`,
      "OLLAMA_MEMORY_PREFLIGHT_FAILED",
    );
  }
  try {
    return await response.json() as Record<string, unknown>;
  } catch {
    throw new ExpectedError(
      `Ollama memory preflight received invalid metadata from ${url}.`,
      "OLLAMA_MEMORY_PREFLIGHT_FAILED",
    );
  }
}

/**
 * Refuses an Ollama request before model loading when host-memory use is already
 * over the ceiling, or when the model's documented size plus conservative
 * headroom would cross it. Missing model metadata fails closed.
 */
export async function assertOllamaMemorySafe(probe: OllamaMemoryProbe): Promise<OllamaMemoryReport> {
  const measured = probe.totalBytes === undefined || probe.freeBytes === undefined
    ? await hostMemory()
    : null;
  const totalBytes = probe.totalBytes ?? measured!.totalBytes;
  const freeBytes = probe.freeBytes ?? measured!.freeBytes;
  if (!Number.isFinite(totalBytes) || totalBytes <= 0 || !Number.isFinite(freeBytes) || freeBytes < 0 || freeBytes > totalBytes) {
    throw new ExpectedError(
      "Ollama memory preflight could not read valid host-memory totals.",
      "OLLAMA_MEMORY_PREFLIGHT_FAILED",
    );
  }

  const fetchImpl = probe.fetchImpl ?? fetch;
  const baseUrl = probe.baseUrl.replace(/\/+$/, "");
  const limitPercent = memoryLimit(probe.limitPercent);
  const [runningJson, tagsJson] = await Promise.all([
    readJson(fetchImpl, `${baseUrl}/api/ps`),
    readJson(fetchImpl, `${baseUrl}/api/tags`),
  ]);
  const running = Array.isArray(runningJson["models"]) ? runningJson["models"] as OllamaModel[] : [];
  const available = Array.isArray(tagsJson["models"]) ? tagsJson["models"] as OllamaModel[] : [];
  const alreadyLoaded = running.some(item =>
    [item.name, item.model].some(name => typeof name === "string" && modelNamesMatch(name, probe.model)),
  );

  let modelBytesAdded = 0;
  if (!alreadyLoaded) {
    const metadata = available.find(item =>
      [item.name, item.model].some(name => typeof name === "string" && modelNamesMatch(name, probe.model)),
    );
    if (!metadata || typeof metadata.size !== "number" || !Number.isFinite(metadata.size) || metadata.size <= 0) {
      throw new ExpectedError(
        `Ollama memory preflight cannot verify the installed size of model "${probe.model}". Pull the model in Ollama and retry.`,
        "OLLAMA_MODEL_SIZE_UNKNOWN",
      );
    }
    modelBytesAdded = Math.ceil(metadata.size * MODEL_HEADROOM_NUMERATOR / MODEL_HEADROOM_DENOMINATOR);
  }

  const usedBytes = totalBytes - freeBytes;
  const currentPercent = usedBytes / totalBytes * 100;
  const projectedPercent = (usedBytes + modelBytesAdded) / totalBytes * 100;
  if (currentPercent >= limitPercent || projectedPercent >= limitPercent) {
    throw new ExpectedError(
      `Ollama request refused: projected host-memory use is ${projectedPercent.toFixed(1)}%, at or above the ${limitPercent}% safety limit.`,
      "OLLAMA_MEMORY_LIMIT",
    );
  }

  return { limitPercent, currentPercent, projectedPercent, modelBytesAdded, alreadyLoaded };
}
