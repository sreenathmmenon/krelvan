# Krelvan — Plugin Sandbox: Research & Plan of Action

*The council's #1 remaining blocker. Today, third-party/marketplace TypeScript plugins run in a
`worker_threads` Worker with full Node `fs` / `net` / `child_process` / `env` — that's crash/state
isolation, NOT a security boundary. An enabled plugin can read the auth token + ledger signing
secret and exfiltrate or forge signed ledger entries.*

---

## 1. The threat (precisely, from the code)

`src/infrastructure/plugins/typescript-plugin-loader.ts` runs a user-supplied `.js` plugin in a
Worker. The Worker:
- shares no memory with main (good — crash isolation) ✅
- but has the **entire Node API**: `fs` (read `data/auth.token`, `data/signing-*.key`, the ledger DB),
  `net`/`fetch` (exfiltrate to an attacker's server — and SSRF guard only covers Krelvan's *own*
  HTTP capabilities, not a plugin's raw `fetch`), `child_process` (spawn anything), `process.env`
  (read every secret) ❌
- has **no `resourceLimits`** (CPU/memory) → a runaway plugin can DoS the host ❌
- receives resolved secrets over the channel as plaintext ❌

So the worker is a *correctness* boundary, not a *security* one. For "install a stranger's plugin
from a marketplace," that's disqualifying. (YAML capabilities are NOT affected — they're declarative
HTTP, no code execution, already safe-by-construction + SSRF-guarded.)

---

## 2. The options (researched) — and why each fits or doesn't

| Option | Isolation strength | Fits Krelvan's "self-hosted single binary, zero-deps, runs on a laptop"? | Verdict |
|---|---|---|---|
| **Node `--permission` model** (stable v22.13+) | Process-level fs/child_process/worker restriction | ❌ **Does NOT inherit to worker threads** (plugins run in a worker); explicitly a "seat belt for *trusted* code — malicious code can bypass." Symlink/fd escapes documented. | **Not sufficient alone** for untrusted code. Useful as defense-in-depth on the *main* process, not as the plugin sandbox. |
| **`node:vm` module** | None (shared realm) | — | ❌ **Never** — every source says it is NOT a sandbox; trivial escapes. Not an option. |
| **`isolated-vm`** (real V8 isolates) | Strong in-process: separate heap, no Node API unless you hand it in, memory + CPU-time limits | ⚠️ **Maintenance mode** (no new features, but maintained for new Node). Native addon (a real dependency — breaks "zero-deps core," needs prebuilds per platform). Known CVE class if you leak references. Recommended to run in a *separate process*. | **Strong middle option** — pure JS isolation, no microVM infra. The realistic "real sandbox in one binary." |
| **Subprocess + Node `--permission`** (run the plugin in a *child process* with `--permission --allow-fs-read=<none>` etc.) | OS-process boundary + permission restriction; deny network by running with no net grant | ✅ Zero new deps (Node built-ins), works on a laptop, child-process IS where `--permission` is meant to apply | **Best fit for Phase 1** — see below. |
| **gVisor / Firecracker / Kata microVM** | Strongest (own kernel / syscall interception) | ❌ Requires Linux + KVM / the gVisor runtime — can't run on a dev laptop or a plain VPS without setup. Breaks "download and run." | **Right for a hosted/enterprise tier later**, wrong for the self-host default. |
| **Don't run untrusted code at all** (YAML/MCP-only for third parties; TS plugins = first-party/org-signed only) | N/A — removes the threat | ✅ Trivial, zero infra | **The honest near-term move** — the council's VP-Product explicitly recommended "amputate, don't sandbox." |

**How comparable platforms do it (for reference):** Cloudflare Workers / Deno Deploy = V8 isolates
(same family as `isolated-vm`); E2B / Modal / Northflank / Daytona = Firecracker/gVisor microVMs as a
*hosted service*. Nobody ships a hardware sandbox *inside a self-host binary* — they either use V8
isolates (in-process) or push untrusted code to a hosted microVM tier. This validates the two-track
plan below.

---

## 3. Recommended plan — tiered, honest, fits the product

The key realization: **Krelvan has two distinct plugin trust levels**, and conflating them is the
root mistake. Split them.

### Track A — Make the trust boundary HONEST now (cheap, high-credibility) ⟵ do first
Don't pretend the worker is a sandbox. Instead:
1. **Tier plugins by trust.** Third-party/marketplace plugins = **YAML or MCP only** (declarative,
   no arbitrary code — already safe + SSRF-guarded). The TS-worker path is reserved for
   **first-party / operator-signed** code the self-hoster explicitly trusts.
2. **Gate untrusted TS execution behind an explicit opt-in** (`KRELVAN_ALLOW_UNTRUSTED_PLUGINS=1` +
   a clear warning), so it can never happen silently.
3. **Stop the secret bleed regardless of sandbox:** don't hand the plugin worker the *resolved*
   plaintext secrets or the data-dir path; the broker should inject secrets at the egress boundary
   (ties to the council's measured-egress proxy). Plugins get placeholders, not credentials.
4. **Add `resourceLimits`** to the existing Worker (memory cap + a hard CPU/time budget) — that's a
   one-liner that closes the DoS/noisy-neighbor gap immediately, sandbox or not.
5. **Correct the docstring + the brief** — the loader's "Security model" comment overclaims; say
   plainly "thread isolation, not a security sandbox; untrusted code requires the Phase-B sandbox."

**Outcome of Track A:** "safe to install marketplace plugins" becomes *true* (they're YAML/MCP, can't
run code), and "run a stranger's TS plugin" is honestly gated + can't read secrets or DoS the box.
This alone moves the council's security needle and removes the dishonesty Karpathy flagged.

### Track B — A REAL sandbox for TS plugins (the actual feature)
Two layers, ship the cheaper one first:
- **B1 — Subprocess + Node Permission Model (default, zero new deps):** run each TS plugin in a
  **child `node` process** launched with `--permission` and NO `--allow-fs-*` / NO child-process /
  NO addons, communicating over stdio (the protocol already exists for the worker). Network denial:
  the child gets no outbound capability except through the brokered egress proxy. This gives an
  OS-process boundary + permission restriction with **only Node built-ins** — preserving the
  zero-dependency, runs-on-a-laptop property. (Mitigates the documented `--permission` escapes by
  also denying child_process/addons and not passing usable file descriptors.)
- **B2 — `isolated-vm` for stronger in-process isolation (optional dependency / enterprise):** for
  operators who want V8-isolate-grade memory/CPU isolation without spawning processes; gated as an
  optional install so the core stays dependency-free.
- **B3 — microVM adapter (hosted/enterprise tier, later):** a pluggable "sandbox port" so a hosted
  Krelvan can run plugins in Firecracker/gVisor. Same interface as B1/B2 behind a port — never
  forced on a self-hoster.

### Why this sequence
- Track A is days of work and **makes the claims honest immediately** — the thing Karpathy said
  matters most ("stop saying marketplace until it's true").
- B1 (subprocess + `--permission`) is the **real sandbox that fits a single self-host binary** with
  zero new dependencies — the property the whole project is built on.
- B2/B3 are upgrades behind a stable port, not rewrites — matching the council's "swappable port"
  architecture praise.
- It also shrinks the OTHER two council blockers: the egress-broker (Track A #3) is the same
  component that makes **cost measured** and secrets scoped.

---

## 4. Tasks (sequenced)

**Track A — honest boundary (do first):**
- A1. Add `resourceLimits` (memory + a CPU/time ceiling) to the TS plugin Worker; reject on breach.
- A2. Tier plugin trust: third-party = YAML/MCP only; TS-worker requires explicit
  `KRELVAN_ALLOW_UNTRUSTED_PLUGINS` opt-in with a startup warning.
- A3. Stop passing resolved plaintext secrets + the data-dir path into the plugin Worker (inject at
  egress instead / pass only what a capability declares).
- A4. Fix the loader docstring + any "sandboxed" wording in docs/brief to "thread isolation, not a
  security sandbox."

**Track B — real sandbox:**
- B1. Define a `SandboxPort` interface (run(pluginPath, call) → result) and implement the default
  **subprocess + `--permission`** adapter (no fs/child_process/addons; stdio protocol; deny network
  except via broker). Tests: a plugin trying to read the secret file / spawn a process / open a
  socket is BLOCKED; a well-behaved plugin still works.
- B2. (Optional) `isolated-vm` adapter behind the same port, as an opt-in dependency.
- B3. (Later) microVM adapter for a hosted tier behind the same port.

**Verification (each task):** typecheck + tests; plus an adversarial "evil plugin" test fixture that
attempts secret-read, process-spawn, network-exfil, and a fork-bomb/CPU-spin — must be blocked.

---

## 4b. STATUS — what's shipped

- **Track A — DONE** (A1–A4): resource limits, untrusted-code opt-in gate, scrubbed
  env (plugins can't read secrets), honest wording.
- **Track B1 — DONE**: `SubprocessPluginLoader` is now the DEFAULT for TS plugins — a
  child `node --permission` process with **fs-write / child_process / native-addons /
  worker / wasi DENIED**, a memory cap, a per-invoke timeout, and a scrubbed env.
  Verified by an adversarial test suite (fs-write blocked, spawn blocked, secret-read
  returns null, CPU-spin killed by timeout, well-behaved plugin works). Fall back to
  the worker loader with `KRELVAN_PLUGIN_SANDBOX=worker`. Zero new dependencies.
  - *Known residual:* the Node permission model has no network flag, so a plugin can
    still open sockets — but with the scrubbed env there are no secrets to exfiltrate.
    Pinning egress is the egress-broker work (separate council item). B2 (`isolated-vm`)
    and B3 (microVM, hosted tier) remain optional future adapters behind the same loader
    interface.

## 5. The one honest line
We will not claim a sandbox until B1 ships. Until then, the truthful posture is: **YAML/MCP plugins
are safe to install; TS plugins run only first-party/explicitly-trusted code, with no secret access
and a resource cap.** That's defensible, matches the code, and is exactly what the council asked for.
