/**
 * Memory capability plugins — connect the engine to the memory planes.
 *
 * Two capabilities:
 *
 *   recall  (side-effect: read)
 *     Reads from the agent's semantic memory store. Injects relevant facts into
 *     run state as "recall.<key>" so subsequent nodes can use them.
 *     Input: { keys?: "key1,key2,..." }  — comma-separated keys to retrieve.
 *             If absent, returns all semantic facts.
 *
 *   remember  (side-effect: read)
 *     Writes an episode summary to the agent's episodic memory.
 *     The engine captures the result as a CAPTURED EffectResult so the episode
 *     is durably recorded in the ledger and survives replay.
 *     Input: { summary?: string } — if absent, auto-summarizes from run state.
 *
 * Both capabilities read/write memory files under:
 *   KRELVAN_DATA_DIR/memory/<agentId>.(episodes|semantic).json
 *
 * The memory file format is intentionally simple flat JSON — the same format
 * that projectMemory() in memory.ts folds from the ledger. We mirror the
 * ledger projection to disk so that recall works across runs without replaying
 * the entire ledger history.
 *
 * If the memory file does not exist, recall returns empty (not an error).
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { CapabilityPlugin, EffectCall } from "../capability/capability.js";
import type { SemanticFact, Episode, Soul } from "../memory/memory.js";
import { getLogger } from "../observability/logger.js";

const log = getLogger("memory-plugins");

const DATA_DIR = process.env["KRELVAN_DATA_DIR"] ?? "./data";
const MEMORY_DIR = join(DATA_DIR, "memory");

function ensureMemoryDir(): void {
  mkdirSync(MEMORY_DIR, { recursive: true });
}

function semanticPath(agentId: string): string {
  return join(MEMORY_DIR, `${agentId}.semantic.json`);
}

function episodicPath(agentId: string): string {
  return join(MEMORY_DIR, `${agentId}.episodes.json`);
}

function soulPath(agentId: string): string {
  return join(MEMORY_DIR, `${agentId}.soul.json`);
}

export function loadSoul(agentId: string): Soul | null {
  const p = soulPath(agentId);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as Soul;
  } catch {
    return null;
  }
}

export function saveSoul(agentId: string, soul: Soul): void {
  ensureMemoryDir();
  writeFileSync(soulPath(agentId), JSON.stringify(soul, null, 2));
}

function loadSemantic(agentId: string): Map<string, SemanticFact> {
  const p = semanticPath(agentId);
  if (!existsSync(p)) return new Map();
  try {
    const arr = JSON.parse(readFileSync(p, "utf8")) as SemanticFact[];
    return new Map(arr.map(f => [f.key, f]));
  } catch {
    return new Map();
  }
}

function loadEpisodic(agentId: string): Episode[] {
  const p = episodicPath(agentId);
  if (!existsSync(p)) return [];
  try {
    return JSON.parse(readFileSync(p, "utf8")) as Episode[];
  } catch {
    return [];
  }
}

function saveSemantic(agentId: string, facts: Map<string, SemanticFact>): void {
  ensureMemoryDir();
  writeFileSync(semanticPath(agentId), JSON.stringify([...facts.values()], null, 2));
}

function saveEpisodic(agentId: string, episodes: Episode[]): void {
  ensureMemoryDir();
  // Keep last 100 episodes to prevent unbounded growth
  const trimmed = episodes.slice(-100);
  writeFileSync(episodicPath(agentId), JSON.stringify(trimmed, null, 2));
}

// ── recall ────────────────────────────────────────────────────────────────────

export const recallCapability: CapabilityPlugin = {
  name: "recall",
  sideEffect: "read",

  estimateCents: () => 1,

  async invoke(call: EffectCall) {
    const input = call.input as Record<string, unknown>;
    const agentId = String(input["agentId"] ?? input["_agentId"] ?? "default");
    const keysParam = input["keys"] ? String(input["keys"]) : null;

    const facts = loadSemantic(agentId);
    const episodes = loadEpisodic(agentId);

    let selected: SemanticFact[];
    if (keysParam) {
      const wanted = keysParam.split(",").map(k => k.trim()).filter(Boolean);
      selected = wanted.flatMap(k => {
        const f = facts.get(k);
        return f ? [f] : [];
      });
    } else {
      selected = [...facts.values()];
    }

    // Flatten into run state keys as "recall.<key>"
    const output: Record<string, string | number | boolean | null> = {};
    for (const f of selected) {
      output[`recall.${f.key}`] = f.value;
    }

    // Also expose recent episode count
    output["recall.episode_count"] = episodes.length;
    if (episodes.length > 0) {
      const last = episodes[episodes.length - 1]!;
      output["recall.last_run_id"] = last.runId;
      output["recall.last_summary"] = last.summary.slice(0, 200);
    }

    log.info({ agentId, retrieved: selected.length, episodeCount: episodes.length }, "recall: loaded memory");

    return { output, claimedCostCents: 1 };
  },
};

// ── remember ──────────────────────────────────────────────────────────────────

export const rememberCapability: CapabilityPlugin = {
  name: "remember",
  sideEffect: "read",

  estimateCents: () => 2,

  async invoke(call: EffectCall) {
    const input = call.input as Record<string, unknown>;
    const agentId = String(input["agentId"] ?? input["_agentId"] ?? "default");
    const runId = String(input["_runId"] ?? call.nodeId ?? "unknown");

    // Build summary from explicit input or from run state
    let summary = input["summary"] ? String(input["summary"]) : null;
    if (!summary) {
      // Auto-summarize: collect think.result and similar meaningful keys
      const parts: string[] = [];
      for (const [k, v] of Object.entries(input)) {
        if (k.endsWith(".result") || k.endsWith(".thought") || k === "result") {
          parts.push(`${k}: ${String(v).slice(0, 150)}`);
        }
      }
      summary = parts.length > 0
        ? parts.join("; ")
        : `Run completed. Node: ${call.nodeId}`;
    }

    const episodes = loadEpisodic(agentId);
    const episode: Episode = {
      runId,
      summary: summary.slice(0, 500),
      provenance: "tool-observed",
      ts: Date.now(),
    };
    episodes.push(episode);
    saveEpisodic(agentId, episodes);

    // Also update semantic facts from the run — any "result" keys become facts
    const facts = loadSemantic(agentId);
    const nextVersion = Math.max(0, ...[...facts.values()].map(f => f.version)) + 1;
    let updated = 0;

    for (const [k, v] of Object.entries(input)) {
      // Promote run state keys ending in .result or .output as semantic facts
      if ((k.endsWith(".result") || k.endsWith(".output")) && v !== null) {
        const factKey = k.replace(/\.(result|output)$/, "").replace(".", "_");
        if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
          facts.set(factKey, {
            key: factKey,
            value: v,
            derivedFrom: [runId],
            provenance: "tool-observed",
            distilledBy: "remember-plugin",
            version: nextVersion,
            ts: Date.now(),
          });
          updated++;
        }
      }
    }

    if (updated > 0) {
      saveSemantic(agentId, facts);
    }

    log.info({ agentId, runId, episodeCount: episodes.length, factsUpdated: updated }, "remember: stored episode");

    return {
      output: { remembered: true, episodeCount: episodes.length, factsUpdated: updated },
      claimedCostCents: 2,
    };
  },
};

// ── identify ──────────────────────────────────────────────────────────────────

export const identifyCapability: CapabilityPlugin = {
  name: "identify",
  sideEffect: "identity-mutation",

  estimateCents: () => 1,

  async invoke(call: EffectCall) {
    const input = call.input as Record<string, unknown>;
    const agentId = String(input["agentId"] ?? input["_agentId"] ?? "default");

    const existing = loadSoul(agentId);
    const nextVersion = (existing?.version ?? 0) + 1;

    // Parse values array — accept comma-separated string or JSON array
    let values: string[] = existing?.values ?? [];
    if (input["values"] !== undefined) {
      const raw = input["values"];
      if (Array.isArray(raw)) {
        values = raw.map(String);
      } else if (typeof raw === "string" && raw.trim().startsWith("[")) {
        try { values = JSON.parse(raw) as string[]; } catch { values = [raw]; }
      } else if (typeof raw === "string") {
        values = raw.split(",").map(s => s.trim()).filter(Boolean);
      }
    }

    // Parse standingInstructions array — same flexible parsing
    let standingInstructions: string[] = existing?.standingInstructions ?? [];
    if (input["standingInstructions"] !== undefined) {
      const raw = input["standingInstructions"];
      if (Array.isArray(raw)) {
        standingInstructions = raw.map(String);
      } else if (typeof raw === "string" && raw.trim().startsWith("[")) {
        try { standingInstructions = JSON.parse(raw) as string[]; } catch { standingInstructions = [raw]; }
      } else if (typeof raw === "string") {
        standingInstructions = raw.split(";").map(s => s.trim()).filter(Boolean);
      }
    }

    const name = input["name"] ? String(input["name"]) : (existing?.name ?? agentId);

    const soul: Soul = { name, values, standingInstructions, version: nextVersion };
    saveSoul(agentId, soul);

    log.info({ agentId, version: nextVersion, valuesCount: values.length }, "identify: soul written");

    return {
      output: {
        "soul.name": soul.name,
        "soul.version": soul.version,
        "soul.valuesCount": soul.values.length,
        "soul.instructionsCount": soul.standingInstructions.length,
      },
      claimedCostCents: 1,
    };
  },
};
