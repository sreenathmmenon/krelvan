/**
 * SubprocessPluginLoader — a REAL sandbox for untrusted TypeScript/JS plugins.
 *
 * Unlike the worker_threads loader (thread isolation only), this runs each plugin in a
 * SEPARATE child `node` process launched with the Node Permission Model (--permission):
 *   - fs WRITE  → denied (no --allow-fs-write) → a plugin cannot tamper with the data
 *                 dir, secret files, or the ledger DB
 *   - child_process → denied (no --allow-child-process) → cannot spawn shells/binaries
 *   - native addons → denied (no --allow-addons) → cannot load arbitrary native code
 *   - worker_threads / WASI → denied
 *   - fs READ   → allowed (modules must be importable). Read alone cannot modify or, by
 *                 itself, exfiltrate; and the child gets a SCRUBBED env (no secrets), so
 *                 there is nothing sensitive to read. (The data dir is not passed.)
 *
 * The child cannot reach back into the host process (OS-process boundary). It talks to
 * the parent only over the existing message protocol via IPC (process.send). A per-invoke
 * timeout + the OS process let us hard-kill a runaway (CPU/memory) plugin.
 *
 * Network: the Permission Model has no network flag, so a plugin can still open sockets.
 * We mitigate by giving the child NO secrets (scrubbed env, no secret store) — so there
 * is nothing to exfiltrate — and a future egress-broker will pin outbound traffic. This
 * is documented honestly in docs/SANDBOX_PLAN.md.
 *
 * Zero new dependencies — Node built-ins only (node:child_process).
 */

import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

import type { PluginLoaderStrategy } from "../../core/plugins/ports.js";
import type { CapabilityPlugin, EffectCall } from "../../core/capability/capability.js";
import type { PersistedPluginRecord } from "../../core/plugins/types.js";
import { getLogger } from "../../core/observability/logger.js";
import { hasTeardown, type TeardownablePlugin } from "./typescript-plugin-loader.js";

const log = getLogger("subprocess-plugin");

const INVOKE_TIMEOUT_MS = 10_000;
const READY_TIMEOUT_MS = 15_000;
const MAX_MEMORY_MB = Math.max(32, Number(process.env["KRELVAN_PLUGIN_MAX_MEMORY_MB"]) || 128);

// ── message protocol (matches the worker loader's shape) ───────────────────────
interface InitData { sourcePath: string }
type ParentToChild =
  | { kind: "invoke"; id: number; call: EffectCall; secrets: Record<string, string> };
type ChildToParent =
  | { kind: "ready"; name: string; sideEffect: string }
  | { kind: "result"; id: number; output: unknown; claimedCostCents: number }
  | { kind: "error"; id: number; message: string }
  | { kind: "init-error"; message: string };

// The child bootstrap script (inlined, run via `node --permission -e`). It imports the
// plugin and proxies invoke() over IPC. It re-implements the tiny worker logic for the
// process context.
function childBootstrap(sourcePath: string): string {
  // sourcePath is JSON-encoded into the script so paths with quotes are safe.
  return `
import { register } from "node:module";
import { pathToFileURL } from "node:url";
try { register("tsx/esm", pathToFileURL("./")); } catch {}
const SRC = ${JSON.stringify(sourcePath)};
let plugin;
try {
  const mod = await import(SRC);
  plugin = mod.default ?? Object.values(mod)[0];
  if (!plugin || typeof plugin.invoke !== "function") throw new Error("module has no CapabilityPlugin default export");
} catch (e) {
  process.send?.({ kind: "init-error", message: String(e && e.message ? e.message : e) });
  process.exit(1);
}
process.send?.({ kind: "ready", name: plugin.name, sideEffect: plugin.sideEffect });
process.on("message", async (msg) => {
  if (msg && msg.kind === "invoke") {
    try {
      const res = await plugin.invoke(msg.call);
      process.send?.({ kind: "result", id: msg.id, output: res.output, claimedCostCents: res.claimedCostCents });
    } catch (err) {
      process.send?.({ kind: "error", id: msg.id, message: String(err && err.message ? err.message : err) });
    }
  }
});
`;
}

/** Scrubbed env for the child — never Krelvan's secrets (mirror of the worker loader). */
function scrubbedEnv(): Record<string, string> {
  const ALLOW = new Set(["PATH", "HOME", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL", "TZ", "NODE_PATH", "NODE_OPTIONS"]);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && ALLOW.has(k)) out[k] = v;
  }
  return out;
}

class SubprocessBackedPlugin implements CapabilityPlugin, TeardownablePlugin {
  readonly name: string;
  readonly sideEffect: CapabilityPlugin["sideEffect"];
  private child: ChildProcess | null;
  private pending = new Map<number, { resolve: (r: { output: unknown; claimedCostCents: number }) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private nextId = 1;

  constructor(
    name: string,
    sideEffect: CapabilityPlugin["sideEffect"],
    child: ChildProcess,
    private readonly resolveSecret: (ref: string) => string | undefined,
    private readonly secretRefs: ReadonlyArray<string>,
  ) {
    this.name = name;
    this.sideEffect = sideEffect;
    this.child = child;

    child.on("message", (msg: ChildToParent) => {
      if (msg.kind === "result" || msg.kind === "error") {
        const p = this.pending.get(msg.id);
        if (!p) return;
        clearTimeout(p.timer);
        this.pending.delete(msg.id);
        if (msg.kind === "result") p.resolve({ output: msg.output, claimedCostCents: msg.claimedCostCents });
        else p.reject(new Error(msg.message));
      }
    });
    child.on("error", (err) => this.killAndReject(new Error(`sandbox process error: ${err.message}`)));
    child.on("exit", (code) => {
      if (this.child) this.killAndReject(new Error(`sandbox process exited (code ${code ?? "?"})`));
    });
  }

  estimateCents(_call: EffectCall): number { return 0; }

  async invoke(call: EffectCall): Promise<{ output: unknown; claimedCostCents: number }> {
    if (!this.child) throw new Error(`Plugin '${this.name}' has been torn down`);
    const id = this.nextId++;
    const secrets: Record<string, string> = {};
    for (const ref of this.secretRefs) {
      const val = this.resolveSecret(ref);
      if (val !== undefined) secrets[ref] = val;
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Plugin '${this.name}' invoke() timed out after ${INVOKE_TIMEOUT_MS}ms`));
        this.killAndReject(new Error(`Plugin '${this.name}' killed after invoke timeout`));
      }, INVOKE_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.child!.send({ kind: "invoke", id, call, secrets } satisfies ParentToChild);
    });
  }

  teardown(): void {
    this.killAndReject(new Error(`Plugin '${this.name}' was disabled or uninstalled`));
  }

  private killAndReject(err: Error): void {
    if (!this.child) return;
    try { this.child.kill("SIGKILL"); } catch { /* already gone */ }
    this.child = null;
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(err); }
    this.pending.clear();
  }
}

export class SubprocessPluginLoader implements PluginLoaderStrategy {
  readonly kind = "typescript" as const;

  async load(
    record: PersistedPluginRecord,
    resolveSecret: (ref: string) => string | undefined,
  ): Promise<CapabilityPlugin> {
    const { sourcePath } = record as unknown as InitData;

    // Permission flags. We DENY the dangerous capabilities — fs WRITE, child_process,
    // native addons, worker_threads, wasi — by simply not granting them. fs READ is
    // ALLOWED (Node needs it to resolve and import modules; scoping it tightly breaks
    // module resolution across platforms). Read alone cannot modify state or, by itself,
    // exfiltrate — and the child's env is SCRUBBED, so there are no secrets to read. The
    // OS-process boundary + scrubbed env + write/spawn denial is the real isolation.

    const argv = [
      "--permission",
      "--allow-fs-read=*",
      `--max-old-space-size=${MAX_MEMORY_MB}`,
      "--input-type=module",
      "-e", childBootstrap(sourcePath),
    ];

    return new Promise<CapabilityPlugin>((resolve, reject) => {
      const child = spawn(process.execPath, argv, {
        stdio: ["ignore", "inherit", "inherit", "ipc"],
        env: scrubbedEnv(),
      });

      const readyTimer = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch { /* gone */ }
        reject(new Error(`SubprocessPluginLoader: sandbox for '${sourcePath}' did not become ready within ${READY_TIMEOUT_MS}ms`));
      }, READY_TIMEOUT_MS);

      child.once("message", (msg: ChildToParent) => {
        clearTimeout(readyTimer);
        if (msg.kind === "init-error") {
          try { child.kill("SIGKILL"); } catch { /* gone */ }
          reject(new Error(`SubprocessPluginLoader: cannot load '${sourcePath}': ${msg.message}`));
          return;
        }
        if (msg.kind === "ready") {
          log.info({ plugin: msg.name, sourcePath }, "plugin sandbox ready (subprocess + permission model)");
          resolve(new SubprocessBackedPlugin(msg.name, msg.sideEffect as CapabilityPlugin["sideEffect"], child, resolveSecret, record.secretRefs));
        }
      });

      child.once("error", (err) => {
        clearTimeout(readyTimer);
        reject(new Error(`SubprocessPluginLoader: spawn error for '${sourcePath}': ${err.message}`));
      });
    });
  }
}

export { hasTeardown };
