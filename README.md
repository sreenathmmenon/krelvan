<div align="center">

# Krelvan

### Own, run, and *trust* your own AI agents.

**Describe a goal in plain English. Krelvan builds a real agent, runs it, and keeps a
signed, replayable record of every step it took — self-hosted, on your machine, yours to keep.**

`The ledger is the runtime` · Self-hostable · Apache-2.0 · Zero runtime deps in core

</div>

---

<div align="center">

_Watch an agent run live — each step lights up as it executes and signs into the ledger._

![A Krelvan agent running live on the canvas](docs/images/demo-agent-run.gif)

_A real Research Analyst run — every step signed into a tamper-evident ledger you can verify offline._

![A completed run with a signed, verifiable ledger](docs/images/run-signed-ledger.png)

_The agent canvas maps 1:1 to what executed — nodes are real steps, the dashed arc is a real retry loop._

![The Krelvan agent canvas](docs/images/canvas.png)

</div>

---

## Why Krelvan

Every AI-agent platform can *describe* what an agent will do. Krelvan can **prove what it
actually did** — and reason about it.

Every run is recorded to an **append-only, content-addressed, cryptographically signed
event log**. The visual canvas, the audit timeline, and the run history are all *reads*
(folds) of that one log. So **"what you see is exactly what executed" is structural, not
hopeful.** That single design choice is the difference between a workflow runner and a
platform you can hand to a regulator, a customer, or a security review.

On top of that record, Krelvan does things only an agentic platform can:

- 🧠 **Builds agents from natural language** — describe an outcome, get a real, validated agent graph.
- 🔍 **Failure-reasoning** — when a run fails, Krelvan reasons over the signed log to find the *root cause*, the failing step, and a concrete fix.
- ♻️ **Auto-retry-with-fix** — it rebuilds a *corrected* agent from that diagnosis and re-runs it. (In our tests: a failed run was diagnosed, fixed, re-run, and **completed**.)
- 🧩 **A marketplace of capabilities AND whole agents** — install a tool (HTTP API, MCP server) or a complete **agent template** (graph + its capabilities + the secrets it needs) from a Git-based registry, in one click. Every capability is labelled with exactly what it can touch and when it pauses for your approval.
- 📦 **Ready-made agents** — a **Price Monitor** (watch a page, alert only when the price changes, on a schedule) and a **RAG Support Bot** (answer grounded only in your docs, cite the source, refuse when it doesn't know) — installable and signed.
- 🔎 **RAG, built in** — `rag.ingest` + `rag.search` over a local vector store, with embeddings from OpenAI, Gemini, or **Ollama (offline, no key)**.
- 🔌 **7 LLM providers** — Anthropic, OpenAI, Gemini, Groq, Mistral, Ollama (local), or any OpenAI-compatible gateway.

---

## Run it in 60 seconds

The web UI and API boot with **no secrets**. LLM features (building agents, explanations,
diagnosis) switch on when you add a provider key.

**Option A — one command (Node 22+):**

```bash
git clone <this-repo> krelvan && cd krelvan
npm install
npx krelvan          # builds core + web on first run, then starts both
```

```
Web UI   http://localhost:3100
API      http://localhost:3201/api/health
```

First run builds the web UI and core; later runs start in seconds. `Ctrl-C` stops both.
Ports: `PORT` (API, default 3201) · `KRELVAN_WEB_PORT` (web, default 3100).

**Option B — Docker:**

```bash
docker compose up --build
```

Same URLs. The SQLite ledger persists in the named volume `krelvan-data`, so your agents
and runs survive restarts.

**Enable LLM features:** copy `.env.example` → `.env` and set a provider + key:

```bash
KRELVAN_LLM_PROVIDER=anthropic
KRELVAN_LLM_MODEL=claude-sonnet-4-6
KRELVAN_LLM_API_KEY=sk-ant-...
```

Or go local with **no key**: `KRELVAN_LLM_PROVIDER=ollama` · `KRELVAN_LLM_MODEL=llama3.2`.
Without any provider the UI still runs and clearly reports LLM as off.

---

## The one principle

**The ledger IS the runtime.** Execution is a projection of an append-only,
content-addressed, signed event log. The canvas, the audit timeline, and the run history
are all pure *reads* of that log. There is no separate "what happened" store that can
drift from "what ran" — they are the same thing.

---

## What's inside

### For the person using it
- **Describe → build → run** an agent from one sentence, with the plan shown before anything executes.
- **Signed run records** — open any run and replay every step, decision, and output.
- **Failure-reasoning + retry-with-fix** — runs that fail get diagnosed and corrected, automatically.

### For companies building on it — "the value isn't features, it's eliminated decisions"
The hard infrastructure is solved so you only build domain logic:

| Solved for you | What it means |
|---|---|
| **Memory** | Episodic + semantic + trust-aware, with provenance — right by default. |
| **Human-in-the-loop** | Standard pause / approve / resume via an autonomy gradient (suggest · act-with-veto · full). |
| **Audit by default** | Every decision, tool call, and step signed to a tamper-evident record. |
| **Capabilities & trust** | Deny-by-default admission; capabilities declare a side-effect class and gate for approval; the supervisor co-signs results (plugins never self-sign). Declarative (YAML) + MCP capabilities are safe by construction. Untrusted TypeScript plugins run in a **real OS-process sandbox** (`node --permission`: fs-write / child_process / native-addons / worker / WASI denied, memory + timeout caps, scrubbed env) and reach the network **only through a brokered, allowlisted, SSRF-guarded egress channel** — secrets are injected at the destination on the host and never enter the plugin. Adversarially tested. |
| **Agent coordination** | Sub-agent delegation with supervisor co-sign. |
| **Failure-reasoning** | Reason about *why* a run failed and how to fix it — not just retry. |
| **Capability ecosystem** | Install a connector; it works in any agent. |

Ship agentic solutions for clients in days, not months.

### The marketplace (a Git repo, not a hosted site)
The "Discover" tab loads a registry `index.json` from a Git repo — the WordPress-style
model. Anyone publishes a capability by opening a PR. Entries are real and installable:

- **YAML capabilities** — wrap any HTTP API (no code).
- **MCP connectors** — connect GitHub, Slack, a filesystem, or any MCP server; every tool it exposes becomes a capability.
- **Agent templates** — a whole pre-built agent (a signed manifest + the capabilities it needs). One click installs the capabilities, creates the agent, and tells you which secrets to set. Ships with **Price Monitor**, **RAG Support Bot**, and **Knowledge Base Ingest**.
- **Deploy capabilities** — ship a site/app to **Vercel, Netlify, Cloudflare Pages, Render, or Railway** via the provider's deploy hook. These are `write-irreversible`, so an agent pauses for your approval before it ships.
- **Free + paid** — paid entries carry pricing + a license link; the platform never touches the money.

### Proven end-to-end

These flagship agents were run to completion through a real LLM provider (Groq,
`llama-3.1-8b-instant`) — each finished with a signed, offline-verifiable ledger:

| Agent | Outcome | Ledger |
|---|---|---|
| **Research Analyst** | search → synthesise → compose a briefing | ✓ 22/22 events signed |
| **Price Monitor** | fetch a page, detect a change vs last run | ✓ 22/22 events signed |
| **Personal Advisor** | grounded advice weighed against your stored goals | ✓ 17/17 events signed |
| **Support Resolution Agent** | triage → retrieve → judge → **pause for your approval** before sending | ✓ 23/23 events signed |

Every provider (Anthropic / OpenAI / Groq / Mistral / Gemini / Ollama / any
OpenAI-compatible gateway) goes through one client with graceful structured-output
fallback, so a model that lacks `json_schema` still produces reliable output.

Authoring guide: [`docs/CAPABILITY_AUTHORING.md`](docs/CAPABILITY_AUTHORING.md). Every PR to the
registry runs a validator ([`registry/validate.test.ts`](registry/validate.test.ts)) — the same pure
validators the runtime uses — so a broken capability or template can't reach the Discover tab.

The default registry is the official one:
[`sreenathmmenon/krelvan-registry`](https://github.com/sreenathmmenon/krelvan-registry).
Point an install at your own fork with
`NEXT_PUBLIC_KRELVAN_REGISTRY_URL=https://raw.githubusercontent.com/<you>/krelvan-registry/main/index.json`
(see [`registry/`](registry/) for the format and the seed catalog).

---

## Architecture — 3 strict layers

1. **UI** — Next.js 15 web app: NL builder, interactive signed-graph canvas (pan/zoom/replay), runs, capabilities marketplace, MCP, approvals, schedules.
2. **API + Runtime** — `node:http` server + the pure kernel / impure engine + the capability plane + the NL→manifest compiler.
3. **Persistence** — SQLite ledger (via `node:sqlite`), zero third-party runtime deps in core.

### Core invariants (every change respects these)
1. **The ledger is the only source of truth** — everything else is a pure fold of it.
2. **The kernel is pure; the engine is the only thing that touches the world.**
3. **No `eval`, ever** — conditional logic is a restricted, total typed-AST evaluator.
4. **Deny-by-default** — an ungranted capability never runs.
5. **Plugins are untrusted** — the supervisor co-signs what it observed; secrets never reach plugins (a broker mints scoped tokens).
6. **Crash-safe by construction** — state lives only in the log; resume = re-fold; effects run exactly once.
7. **Zero third-party runtime deps in core** — Node built-ins only, license-clean, small to self-host.

| Layer | Where | Proven by |
|---|---|---|
| **Ledger** | `src/core/ledger/` | canonicalization, content-addressing, hash-chaining, signed events (**Ed25519 by default = non-repudiable**, verifiable from the public key alone; HMAC available via env), CAS append (no forks), `verify()` catches every corruption |
| **Manifest + safe expr** | `src/core/manifest/` | structural validation; conditional edges are a typed AST — never `eval` |
| **Capability plane** | `src/core/capability/` | deny-by-default, autonomy gradient, supervisor co-sign |
| **Pure kernel + engine** | `src/core/kernel/` | pure `decide()`; 3-event effect protocol; crash-hole HALT; resume |
| **Memory** | `src/core/memory/` | episodic/semantic planes, provenance, untrusted-inbound quarantine |
| **Compiler** | NL → signed manifest, with capability monotonicity (prompt injection can't escalate) |

---

## Verify it yourself

```bash
npm install
npm run typecheck    # strict TS, clean
npm test             # 297 / 300 pass (3 are live-model API tests that need a key)
npm run demo:ledger  # canvas + audit all fold from one log
npm run demo:resume  # kill mid-run, resume — each irreversible effect runs EXACTLY once
npm run demo:e2e     # a real 3-agent pipeline drives itself off the ledger
npm run demo:compile # intent → compiled + signed manifest → run; untrusted principal rejected
npm run demo:live    # (needs KRELVAN_ANTHROPIC_KEY) a real model proposes a workflow,
                     # the compiler signs it within authority, the engine runs it, the log verifies
```

---

## Status — honest

**Built & verified** (typecheck clean · 297/300 tests · web build green):
- Ledger + SQLite durable store (real on-disk crash/resume)
- Identity, secrets & time (key rotation/revocation, secret broker, monotonic clock)
- Capability plane (deny-by-default, autonomy gradient, supervisor co-sign)
- Manifest + safe expressions (typed AST, never eval)
- Pure kernel + engine (3-event effect protocol, crash-hole HALT, resume)
- NL→manifest compiler (capability monotonicity)
- Memory (multi-plane, provenance, untrusted-inbound gate)
- **Full web UI** — NL builder, signed-graph canvas, runs, capabilities marketplace, MCP, approvals, schedules
- **Capabilities marketplace** — Git-registry-backed (live at [`krelvan-registry`](https://github.com/sreenathmmenon/krelvan-registry)), view/edit YAML source online, MCP connectors
- **Deploy capabilities** — Vercel / Netlify / Cloudflare Pages / Render / Railway, gated as write-irreversible
- **Failure-reasoning + auto-retry-with-fix** — diagnose a failed run from the ledger, rebuild a corrected agent, re-run
- **7 LLM providers** behind one client (Anthropic/OpenAI/Gemini/Groq/Mistral/Ollama/OpenAI-compatible)

**Asymmetric ledger signing (ed25519) — the default on a fresh install.** A new data dir signs
the ledger with per-install Ed25519 keys. The **public** keys are published at
`GET /api/ledger/keys` (no auth) so an auditor, regulator, or counterparty can **independently
verify the ledger without any secret** — `npx krelvan verify <bundle>` does exactly this, offline.
The private key never leaves the signer, so nobody but the holder can produce a signature that
verifies against that key.

> **Verifying *authenticity of origin* needs one extra step — pin the key.** Run unpinned,
> `npx krelvan verify` checks every signature against the public keys *included in the bundle*:
> that proves the run is internally consistent and unaltered, but **not** which instance produced
> it (a forger could ship their own keypair inside their own file). The verifier says so plainly
> (`✓ CONSISTENT`, not `authentic`) and prints each key's fingerprint. To prove origin, fetch the
> issuer's real public key from `GET /api/ledger/keys` and pass it: `npx krelvan verify <bundle>
> --key issuer.pem` → `✓ VERIFIED · authentic` (and a forged key is rejected as `✗ WRONG SIGNER`).

Set `KRELVAN_LEDGER_SIGNING=hmac` to force the symmetric HMAC adapter instead (tamper-evident,
but instance-local — not third-party verifiable). An **existing HMAC install keeps using HMAC**
automatically, so the history it already signed stays verifiable.

> **Don't switch an existing HMAC data dir to Ed25519.** Events written before the switch were
> signed with HMAC, which the Ed25519 verifier can't check — historical runs would read as
> "verification failed." The boot log warns if you try. Start fresh for a clean Ed25519 history.

**Export & verify a run anywhere.** `GET /api/runs/:id/export` (or the "Download proof" button on
any run) produces a portable bundle — every event with its signature, plus the public keys.
Anyone can re-check it offline with **zero dependencies**:

```bash
npx krelvan verify krelvan-proof-<run>.json
#   content addresses : all 7 match
#   signatures        : all 7 valid          (ed25519 only)
#   key trust         : self-included (not pinned)
#   run boundaries    : RunStarted → terminal
#   ✓ CONSISTENT — internally consistent and unaltered (pin --key to prove origin)

npx krelvan verify krelvan-proof-<run>.json --key issuer.pem
#   ✓ VERIFIED · authentic — provably from the holder of that key
```

It recomputes each content address, verifies every Ed25519 signature, and rejects a bundle whose
run start/end was omitted or whose signing key doesn't match a pinned `--key` (`✗ WRONG SIGNER`).
(HMAC bundles report *partially verified · instance-local* — tamper-evident, but not third-party
verifiable by design.)

## Backups & the data directory

Everything Krelvan persists lives in one place (`KRELVAN_DATA_DIR`, default `./data`). **Back it up
as a unit** — several files are unrecoverable if lost:

| File | What it holds | If lost |
| --- | --- | --- |
| `ledger.db` (+ `-wal`, `-shm`) | the signed event log — every run | the history is gone |
| `secret.key` | AES-256-GCM key for the secret store | **all stored secrets + in-app model config decrypt to nothing** |
| `signing-{owner,supervisor}.key` (HMAC) or `signing-*-ed25519.{key,pub}` | ledger signing keys | **the existing ledger can no longer be verified** |
| `*.json`, `admin.auth`, `launcher.token` | agents/runs/registries, the admin credential, the launcher token | re-provision |

Snapshot the whole directory atomically (stop the process or use a consistent volume snapshot).
Do **not** back up `ledger.db` alone — without `secret.key` and the signing keys it is unusable.

**Not yet built:** PostgreSQL multi-tenant store adapter; asymmetric *publisher* signing for
third-party marketplace trust (distinct from ledger signing above). Tracked in `docs/PREMORTEM.md`.

---

## Docs

- [`AGENTS.md`](AGENTS.md) — engineering rules & architecture (read before contributing)
- [`docs/AGENTIC_CAPABILITIES.md`](docs/AGENTIC_CAPABILITIES.md) — researched catalog of genuinely-agentic capabilities + roadmap
- [`docs/LEDGER_SPEC.md`](docs/LEDGER_SPEC.md) — the ledger contract & invariants
- [`docs/PREMORTEM.md`](docs/PREMORTEM.md) — enumerated failure modes, each with a guard + status
- [`registry/`](registry/) — the capability marketplace registry (format + seed)

## License

Apache-2.0. Self-host it, run it for yourself / your team / your clients, extend it, and
build paid or free solutions on top — you own what you build.
