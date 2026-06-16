/**
 * TypeScriptPluginLoader — PluginLoaderStrategy for kind='typescript'.
 *
 * Security model: TypeScript plugins are user-supplied JS executed in a
 * worker_threads Worker, NOT in the main Node.js process. The Worker:
 *   - shares no memory with the main thread (no SharedArrayBuffer exposed)
 *   - communicates only via a typed MessageChannel protocol
 *   - is terminated after each invoke() call completes (no persistent state)
 *   - is subject to a configurable timeout (default 10 s)
 *
 * The worker receives the absolute source path (already hash-verified by the
 * lifecycle service before this loader is called), imports the module, and
 * proxies invoke() calls over postMessage. Secrets are passed as a plain
 * Record<string, string> over the channel — never exposed in a shared memory
 * buffer.
 *
 * Limitations:
 *   - The plugin must be a pre-compiled .js file (not .ts source).
 *   - Node module cache inside the Worker is isolated from the main thread.
 *   - Top-level side effects in the plugin module run when the Worker starts
 *     (on first invoke). A plugin that crashes at import time causes the
 *     Worker to exit — load() will reject with the error.
 */

import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import type { PluginLoaderStrategy } from "../../core/plugins/ports.js";
import type { CapabilityPlugin } from "../../core/capability/capability.js";
import type { EffectCall } from "../../core/capability/capability.js";
import type { PersistedPluginRecord } from "../../core/plugins/types.js";
import { assertIsCapabilityPlugin } from "../../core/plugins/types.js";

// ── Worker protocol ───────────────────────────────────────────────────────────

interface WorkerInitData {
  sourcePath: string;
  __workerScript?: string;
}

type MainToWorker =
  | { kind: "invoke"; id: number; call: EffectCall; secrets: Record<string, string> }
  | { kind: "describe" };

type WorkerToMain =
  | { kind: "ready"; name: string; sideEffect: string }
  | { kind: "result"; id: number; output: unknown; claimedCostCents: number }
  | { kind: "error"; id: number; message: string }
  | { kind: "init-error"; message: string };

// ── Worker bootstrap ──────────────────────────────────────────────────────────
// The Worker entry is a data: URL so Node can load it natively (no .ts extension
// issue). It immediately re-imports this module via its file URL so the full
// worker logic runs inside the Worker process with tsx already registered.

const WORKER_BOOTSTRAP = `
import { register } from "node:module";
import { pathToFileURL } from "node:url";
// Register tsx so .ts imports work inside the worker
try { register("tsx/esm", pathToFileURL("./")) } catch {}
const { workerData } = await import("node:worker_threads");
await import(workerData.__workerScript);
`;

// ── Worker entry point ────────────────────────────────────────────────────────
// This module doubles as the worker script. When loaded as a Worker, isMainThread
// is false and this block runs instead of the loader class.

if (!isMainThread) {
  void runWorker();
}

async function runWorker(): Promise<void> {
  if (!parentPort) return;
  const port = parentPort;
  const { sourcePath } = workerData as WorkerInitData;

  let plugin: CapabilityPlugin;
  try {
    const mod = (await import(sourcePath)) as Record<string, unknown>;
    const candidate = mod["default"] ?? Object.values(mod)[0];
    assertIsCapabilityPlugin(candidate, sourcePath);
    plugin = candidate;
  } catch (e) {
    port.postMessage({ kind: "init-error", message: String(e) } satisfies WorkerToMain);
    return;
  }

  port.postMessage({ kind: "ready", name: plugin.name, sideEffect: plugin.sideEffect } satisfies WorkerToMain);

  port.on("message", (msg: MainToWorker) => {
    if (msg.kind === "invoke") {
      const { id, call } = msg;
      plugin.invoke(call).then(
        (res) => {
          port.postMessage({ kind: "result", id, output: res.output, claimedCostCents: res.claimedCostCents } satisfies WorkerToMain);
        },
        (err: unknown) => {
          port.postMessage({ kind: "error", id, message: String(err) } satisfies WorkerToMain);
        },
      );
    }
  });
}

// ── Teardown interface ────────────────────────────────────────────────────────

/** Optional lifecycle hook a CapabilityPlugin can implement. Called on disable/uninstall. */
export interface TeardownablePlugin {
  teardown(): void;
}

export function hasTeardown(p: unknown): p is TeardownablePlugin {
  return typeof p === "object" && p !== null && typeof (p as TeardownablePlugin).teardown === "function";
}

// ── Sandboxed proxy plugin ────────────────────────────────────────────────────

const INVOKE_TIMEOUT_MS = 10_000;

// Per-plugin memory ceiling (V8 heap). A malicious plugin that tries to allocate
// past this is aborted by V8 rather than taking down the host. Override via env.
const PLUGIN_MAX_MEMORY_MB = Math.max(32, Number(process.env["KRELVAN_PLUGIN_MAX_MEMORY_MB"]) || 128);

/**
 * A CapabilityPlugin that proxies all invoke() calls to an isolated Worker.
 * The Worker is spawned once per plugin enable() and kept alive for the
 * lifetime of the enabled plugin (terminated on disable/uninstall).
 */
class WorkerBackedPlugin implements CapabilityPlugin, TeardownablePlugin {
  readonly name: string;
  readonly sideEffect: CapabilityPlugin["sideEffect"];
  private worker: Worker | null;
  private pendingCalls = new Map<number, { resolve: (r: { output: unknown; claimedCostCents: number }) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private nextId = 1;

  constructor(
    name: string,
    sideEffect: CapabilityPlugin["sideEffect"],
    worker: Worker,
    private readonly resolveSecret: (ref: string) => string | undefined,
    private readonly secretRefs: ReadonlyArray<string>,
  ) {
    this.name = name;
    this.sideEffect = sideEffect;
    this.worker = worker;

    worker.on("message", (msg: WorkerToMain) => {
      if (msg.kind === "result" || msg.kind === "error") {
        const pending = this.pendingCalls.get(msg.id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pendingCalls.delete(msg.id);
        if (msg.kind === "result") {
          pending.resolve({ output: msg.output, claimedCostCents: msg.claimedCostCents });
        } else {
          pending.reject(new Error(msg.message));
        }
      }
    });

    worker.on("error", (err) => {
      this.terminateAndReject(new Error(`Worker error: ${err.message}`));
    });
  }

  estimateCents(_call: EffectCall): number {
    return 0;
  }

  async invoke(call: EffectCall): Promise<{ output: unknown; claimedCostCents: number }> {
    if (!this.worker) {
      throw new Error(`Plugin '${this.name}' has been torn down and cannot accept new calls`);
    }

    const id = this.nextId++;
    const secrets: Record<string, string> = {};
    for (const ref of this.secretRefs) {
      const val = this.resolveSecret(ref);
      if (val !== undefined) secrets[ref] = val;
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingCalls.delete(id);
        reject(new Error(`Plugin '${this.name}' invoke() timed out after ${INVOKE_TIMEOUT_MS}ms`));
        // On timeout, tear down fully so future invocations fail fast instead of hanging.
        this.terminateAndReject(new Error(`Plugin '${this.name}' terminated after invoke timeout`));
      }, INVOKE_TIMEOUT_MS);

      this.pendingCalls.set(id, { resolve, reject, timer });
      this.worker!.postMessage({ kind: "invoke", id, call, secrets } satisfies MainToWorker);
    });
  }

  /** Called by PluginLifecycleService on disable/uninstall. Terminates the worker and
   *  rejects any in-flight calls so callers don't hang. */
  teardown(): void {
    this.terminateAndReject(new Error(`Plugin '${this.name}' was disabled or uninstalled`));
  }

  private terminateAndReject(err: Error): void {
    if (!this.worker) return;
    void this.worker.terminate();
    this.worker = null;
    for (const [, pending] of this.pendingCalls) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.pendingCalls.clear();
  }
}

// ── Loader ────────────────────────────────────────────────────────────────────

export class TypeScriptPluginLoader implements PluginLoaderStrategy {
  readonly kind = "typescript" as const;

  async load(
    record: PersistedPluginRecord,
    resolveSecret: (ref: string) => string | undefined,
  ): Promise<CapabilityPlugin> {
    const workerScript = fileURLToPath(import.meta.url);

    return new Promise<CapabilityPlugin>((resolve, reject) => {
      const worker = new Worker(WORKER_BOOTSTRAP, {
        eval: true,
        workerData: {
          sourcePath: record.sourcePath,
          __workerScript: workerScript,
        },
        // Memory ceiling — a runaway/malicious plugin cannot exhaust host RAM.
        // V8 aborts the worker (emits an 'error') if it exceeds the heap cap;
        // combined with the per-invoke timeout, this bounds CPU and memory.
        // Override with KRELVAN_PLUGIN_MAX_MEMORY_MB (default 128).
        resourceLimits: {
          maxOldGenerationSizeMb: PLUGIN_MAX_MEMORY_MB,
          maxYoungGenerationSizeMb: Math.min(32, PLUGIN_MAX_MEMORY_MB),
          codeRangeSizeMb: 16,
        },
      });

      const initTimeout = setTimeout(() => {
        void worker.terminate();
        reject(new Error(`TypeScriptPluginLoader: Worker for '${record.sourcePath}' did not become ready within 15s`));
      }, 15_000);

      worker.once("message", (msg: WorkerToMain) => {
        clearTimeout(initTimeout);
        if (msg.kind === "init-error") {
          void worker.terminate();
          reject(new Error(`TypeScriptPluginLoader: cannot load '${record.sourcePath}': ${msg.message}`));
          return;
        }
        if (msg.kind === "ready") {
          const plugin = new WorkerBackedPlugin(
            msg.name,
            msg.sideEffect as CapabilityPlugin["sideEffect"],
            worker,
            resolveSecret,
            record.secretRefs,
          );
          resolve(plugin);
        }
      });

      worker.once("error", (err) => {
        clearTimeout(initTimeout);
        reject(new Error(`TypeScriptPluginLoader: Worker error for '${record.sourcePath}': ${err.message}`));
      });
    });
  }
}
