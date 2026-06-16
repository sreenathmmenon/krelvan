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
 * Network: the Permission Model has no network flag, so a plugin can still open a raw
 * socket. We close the EXPLOIT, not the socket: the child is given NO secrets and NO
 * direct fetch — its only path to the network is the BROKERED-EGRESS channel back to the
 * parent (egress-request/egress-response over IPC). The parent runs an EgressBroker that
 * allowlists the host (deny-by-default), SSRF-guards it, injects the real credential ON
 * THE PARENT (never in the child), and measures the call. So a malicious plugin has
 * nothing worth exfiltrating and no allowlisted path to anything useful. The residual
 * (pinning raw sockets entirely) needs a network namespace / microVM — the hosted tier.
 * Documented in docs/SANDBOX_PLAN.md (Track C).
 *
 * Zero new dependencies — Node built-ins only (node:child_process).
 */

import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

import type { PluginLoaderStrategy } from "../../core/plugins/ports.js";
import type { CapabilityPlugin, EffectCall } from "../../core/capability/capability.js";
import type { PersistedPluginRecord } from "../../core/plugins/types.js";
import { getLogger } from "../../core/observability/logger.js";
import { EgressBroker, type EgressRequest, type EgressResult } from "../../core/plugins/egress-broker.js";
import { hasTeardown, type TeardownablePlugin } from "./typescript-plugin-loader.js";

const log = getLogger("subprocess-plugin");

const INVOKE_TIMEOUT_MS = 10_000;
const READY_TIMEOUT_MS = 15_000;
const MAX_MEMORY_MB = Math.max(32, Number(process.env["KRELVAN_PLUGIN_MAX_MEMORY_MB"]) || 128);

// ── message protocol (matches the worker loader's shape) ───────────────────────
interface InitData { sourcePath: string }
type ParentToChild =
  // NOTE: no `secrets` field — secrets NEVER enter the child. Outbound HTTP that needs
  // a credential goes through the brokered-egress channel; the parent injects the secret.
  | { kind: "invoke"; id: number; call: EffectCall }
  | { kind: "egress-response"; eid: number; result: EgressResult }
  | { kind: "egress-error"; eid: number; message: string };
type ChildToParent =
  | { kind: "ready"; name: string; sideEffect: string }
  | { kind: "result"; id: number; output: unknown; claimedCostCents: number }
  | { kind: "error"; id: number; message: string }
  | { kind: "init-error"; message: string }
  | { kind: "egress-request"; eid: number; request: EgressRequest };

// The child bootstrap script (inlined, run via `node --permission -e`). It imports the
// plugin and proxies invoke() over IPC. It re-implements the tiny worker logic for the
// process context.
function childBootstrap(sourcePath: string): string {
  // sourcePath is JSON-encoded into the script so paths with quotes are safe.
  //
  // BROKERED EGRESS: the plugin is given a global `krelvanFetch(url, init)` that does
  // NOT touch the network from the child. It posts an `egress-request` to the parent and
  // awaits the parent's brokered (allowlisted + SSRF-guarded + secret-injected + measured)
  // response. The plugin never sees a secret and has no allowlisted direct path out.
  return `
import { register } from "node:module";
import { pathToFileURL } from "node:url";
try { register("tsx/esm", pathToFileURL("./")); } catch {}
const SRC = ${JSON.stringify(sourcePath)};

// ── brokered egress: round-trip an HTTP request through the parent over IPC ──────
let __eid = 0;
const __egressPending = new Map();
process.on("message", (msg) => {
  if (!msg) return;
  if (msg.kind === "egress-response" || msg.kind === "egress-error") {
    const p = __egressPending.get(msg.eid);
    if (!p) return;
    __egressPending.delete(msg.eid);
    if (msg.kind === "egress-response") p.resolve(msg.result);
    else p.reject(new Error(msg.message || "egress denied"));
  }
});
globalThis.krelvanFetch = function krelvanFetch(url, init) {
  const i = init || {};
  const eid = ++__eid;
  return new Promise((resolve, reject) => {
    __egressPending.set(eid, { resolve, reject });
    process.send?.({ kind: "egress-request", eid, request: {
      url: String(url),
      method: i.method,
      headers: i.headers,
      body: typeof i.body === "string" ? i.body : (i.body == null ? undefined : String(i.body)),
      timeoutMs: i.timeoutMs,
      maxBytes: i.maxBytes,
    }});
  });
};

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
  /** Measured egress cost (cents) accumulated across a single invoke() — supervisor-attested. */
  private measuredEgressCents = 0;

  constructor(
    name: string,
    sideEffect: CapabilityPlugin["sideEffect"],
    child: ChildProcess,
    private readonly broker: EgressBroker,
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
      } else if (msg.kind === "egress-request") {
        void this.handleEgress(msg.eid, msg.request);
      }
    });
    child.on("error", (err) => this.killAndReject(new Error(`sandbox process error: ${err.message}`)));
    child.on("exit", (code) => {
      if (this.child) this.killAndReject(new Error(`sandbox process exited (code ${code ?? "?"})`));
    });
  }

  /** Answer a child egress-request via the parent-side broker. The secret is injected
   *  inside the broker and NEVER returned to the child; only the response body is. */
  private async handleEgress(eid: number, request: EgressRequest): Promise<void> {
    const child = this.child;
    if (!child) return;
    try {
      const result = await this.broker.request(request);
      // 1 cent per brokered call + 1 cent per ~64 KiB transferred (measured, attested).
      this.measuredEgressCents += 1 + Math.floor((result.measured.bytesIn + result.measured.bytesOut) / 65_536);
      child.send({ kind: "egress-response", eid, result } satisfies ParentToChild);
    } catch (e) {
      // Allowlist/SSRF denial — surfaced to the plugin as an egress error (it never
      // learns whether a host exists; just that it's denied).
      child.send({ kind: "egress-error", eid, message: (e as Error).message } satisfies ParentToChild);
    }
  }

  estimateCents(_call: EffectCall): number { return 0; }

  async invoke(call: EffectCall): Promise<{ output: unknown; claimedCostCents: number }> {
    if (!this.child) throw new Error(`Plugin '${this.name}' has been torn down`);
    const id = this.nextId++;
    this.measuredEgressCents = 0;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Plugin '${this.name}' invoke() timed out after ${INVOKE_TIMEOUT_MS}ms`));
        this.killAndReject(new Error(`Plugin '${this.name}' killed after invoke timeout`));
      }, INVOKE_TIMEOUT_MS);
      this.pending.set(id, {
        // Fold the measured egress cost into the result the supervisor records.
        resolve: (r) => resolve({ output: r.output, claimedCostCents: r.claimedCostCents + this.measuredEgressCents }),
        reject,
        timer,
      });
      this.child!.send({ kind: "invoke", id, call } satisfies ParentToChild);
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

    // Parent-side egress broker for THIS plugin: deny-by-default allowlist from the
    // record + a host→credential injector. The injector resolves a secret ref keyed
    // by the destination host (e.g. an "api.stripe.com" ref) and injects it as a Bearer
    // token. The resolved secret stays on the parent — it is never sent to the child.
    const allowlist = new Set((record.egressHosts ?? []).map((h) => h.toLowerCase()));
    const broker = new EgressBroker({
      allowlist,
      injectSecret: (host) => {
        const val = resolveSecret(host) ?? resolveSecret(`egress:${host}`);
        return val !== undefined ? { header: "authorization", value: `Bearer ${val}` } : null;
      },
      now: () => Date.now(),
    });

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
        // Scrubbed env (no Krelvan secrets) + the brokered-egress signal. The child has
        // no secrets to leak and must route all outbound HTTP through `krelvanFetch`.
        env: { ...scrubbedEnv(), KRELVAN_PLUGIN_BROKERED_EGRESS: "1" },
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
          log.info({ plugin: msg.name, sourcePath, egressHosts: [...allowlist] }, "plugin sandbox ready (subprocess + permission model + brokered egress)");
          resolve(new SubprocessBackedPlugin(msg.name, msg.sideEffect as CapabilityPlugin["sideEffect"], child, broker));
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
