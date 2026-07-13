# Krelvan — Architecture Deep Dive

*A complete map of genesis-new as built today: every layer, every file, every
design decision, and exactly why each one exists. Start here if you're new to the
codebase or returning after time away.*

*For the strategy and roadmap, see MASTER_PLAN.md.*
*For the ledger contract and invariants, see LEDGER_SPEC.md.*
*For the 435-item failure-mode registry, see PREMORTEM.md.*

---

## The one principle (everything else flows from this)

> **The ledger IS the runtime.**

Execution is not a side effect of calling code. It is a *projection* of an
append-only, content-addressed, signed event log. The canvas, the
audit timeline, and agent memory are all pure *reads* (folds) of that one log.

This means:
- **Resume is free.** Crash at any point; on restart, fold the log and continue.
- **No double-execution.** An effect whose idempotency key already has a result is
  re-served, never re-run.
- **What you see is what executed — structurally.** The canvas is a fold; it cannot
  lie about what ran.
- **Time travel is a fold.** Rewind to any past state by folding only up to that
  offset.
- **Counterfactual replay.** Fork from any node; re-gate every downstream effect
  through admission — a "what if" can never accidentally re-spend money.

---

## The layer map

```
┌──────────────────────────────────────────────────────────┐
│  web/           Next.js UI — canvas, trace, audit    │  (built, port 3100)
└─────────────────────────┬────────────────────────────────┘
                          │  REST / WebSocket
┌─────────────────────────┴────────────────────────────────┐
│  src/adapters/          Model adapter (Anthropic + fake)  │
├──────────────────────────────────────────────────────────┤
│  src/core/compiler/     NL → Manifest (trust boundary)    │
├──────────────────────────────────────────────────────────┤
│  src/core/kernel/       Pure kernel + impure engine       │
│  src/core/capability/   Admission + Supervisor            │
│  src/core/manifest/     Manifest schema + safe expr AST   │
├──────────────────────────────────────────────────────────┤
│  src/core/channels/     Channel adapters + resolver       │
│  src/core/memory/       Four memory planes (ledger folds) │
│  src/core/observability/ Canvas/cost/timeline/replay      │
│  src/core/identity/     Key lifecycle + secret broker     │
├──────────────────────────────────────────────────────────┤
│  src/core/ledger/       The foundation: event log + store │
└──────────────────────────────────────────────────────────┘
```

Everything above the ledger is a pure consumer of it. Nothing reaches past its
layer boundary. The kernel is pure (no I/O); the engine is the only code that
touches the world.

---

## Layer 1 — The Ledger (`src/core/ledger/`)

The foundation. Every other layer is a fold of this.

### What it is

An append-only, content-addressed, hash-chained, signed event log. Every causal
step in a run — a node starting, an effect being requested, a result arriving — is
one event. The store is a **port** (interface); adapters plug in behind it.

### Files

| File | Role |
|---|---|
| `event.ts` | The `LedgerEvent` type + `EventType` enum + `preimageBytes` / `computeId` |
| `canonical.ts` | Deterministic JSON serialisation (sorted keys, no floats, safe ints only) |
| `crypto.ts` | HMAC-SHA256 content-addressing + `HmacKeyring` (sign / verify with time windows) |
| `store.ts` | `LedgerStore` port + `InMemoryLedgerStore` adapter + `verify()` |
| `sqlite-store.ts` | SQLite durable adapter (crash-safe, real on-disk resume) |
| `errors.ts` | Typed error enum — every failure mode is a named kind, never a raw string |

### The event shape

```typescript
interface LedgerEvent<P = unknown> {
  // --- content address covers ALL of these (LED-03) ---
  type: EventType;       // "RunStarted" | "NodeEntered" | "EffectRequested" | ...
  scope: EventScope;     // { tenantId, runId, nodeId?, branchId }
  parents: Hash[];       // causal parents (must already exist)
  prev: Hash | null;     // chain linkage (previous event in this tenant)
  offset: Offset;        // monotonic, gap-free per tenant
  payload: P;            // event-type-specific data
  determinism: "pure" | "captured";  // only EffectResult may be "captured"
  ts: number;            // monotonic logical clock (not wall clock)
  author: string;        // key id of the signer

  // --- derived / assigned ---
  id: Hash;              // contentAddress(preimageBytes(all above))
  sig: Signature;        // HMAC over id, signed by author's key
}
```

### The eight invariants (from LEDGER_SPEC)

- **I1 Content address** — `event.id == hash(canonical(preimage))`. One mutated byte changes the id.
- **I2 Append-only** — never updated, never deleted.
- **I3 Monotonic offsets** — gap-free, starting at 0, within a tenant.
- **I4 Chain linkage** — `event.prev == id of previous event` (or null for genesis).
- **I5 Causal parents exist** — every hash in `parents` was already appended.
- **I6 Signature valid** — HMAC verifies against the author's registered key.
- **I7 Determinism honesty** — `"captured"` only on `EffectResult`; all others are `"pure"`.
- **I8 Projection purity** — `fold(events) → state` is deterministic; same events in, same state out.

### The effect protocol (three events per side effect)

Every side effect — a tool call, a message, a spend — is exactly three events:

```
AdmissionDecision   (pure, kernel-authored)
  → did the capability plane allow this effect?

EffectRequested     (pure, kernel-authored)
  → this effect is now officially requested; carries the idempotency key

EffectResult        (captured, SUPERVISOR-signed)
  → what the supervisor mechanically observed: actual cost, output, plugin claim
```

This three-event protocol is what makes crash-safe resume work: if the process dies
after `EffectRequested` but before `EffectResult`, the engine sees a crash hole on
resume and HALTs rather than blindly re-running the effect.

### Canonicalization

`canonical.ts` produces deterministic JSON: object keys sorted recursively, no
insignificant whitespace, arrays in order. Floats, NaN, Infinity, BigInt, and
unsafe integers are all rejected (they would make hashing unstable). All costs are
**integer cents** — never floats, never `0.1 + 0.2` surprises.

### The store port

```typescript
interface LedgerStore {
  append<P>(event: NewEvent<P>, opts: { ts: number; signer: Signer }): Promise<Result<LedgerEvent<P>, LedgerError>>;
  readRun(tenantId: string, runId: string): Promise<readonly LedgerEvent[]>;
}
```

The store assigns the offset, validates `prev`, signs, and appends atomically.
`OptimisticConflict` is returned when two appenders race; the caller re-reads the
head and retries. Two adapters exist: `InMemoryLedgerStore` (tests) and
`SqliteLedgerStore` (durable, crash-safe, real on-disk resume).

---

## Layer 2 — The Manifest (`src/core/manifest/`)

The declarative program the user owns. The manifest is what compounds across
model generations — it is not a prompt, not a model call, not executable code.

### `manifest.ts`

```typescript
interface Manifest {
  version: 1;
  name: string;
  intent: string;          // the original NL intent, for provenance
  nodes: ManifestNode[];
  edges: ManifestEdge[];
  entry: string;           // entry node id
  runBudgetCents: number;  // hard ceiling for the entire run
  maxNodeVisits: number;   // anti-runaway loop bound
}

interface ManifestNode {
  id: string;
  role: string;            // human description (not executed)
  capabilities: CapabilityRef[];  // deny-by-default: anything not listed is denied
  autonomy: AutonomyLevel; // "suggest" | "act-with-veto" | "full"
}

interface CapabilityRef {
  name: string;            // resolved to a plugin at run time
  sideEffect: SideEffectClass;
  budgetCents: number;     // hard ceiling per capability per run
}
```

**Key property**: the manifest names capabilities by string. The actual plugin
that satisfies a capability is resolved at run time, behind the supervisor. The
manifest survives every model and every plugin swap — it is the stable artifact.

`validateManifest()` is a pure function that catches structural errors before any
run: duplicate node ids, dangling edges, bad entry, negative budgets.

### `expr.ts` — the safe expression evaluator

Conditional edges carry a typed AST, not a string of code. The evaluator is:
- **Total** — every path returns a value or throws a typed error; no partial cases
- **Side-effect-free** — reads `runState[key]` only; no I/O, no closures, no calls
- **Non-Turing-complete** — no loops, no function calls, no property access chains
- **Depth-bounded** — max 32 levels, enforced recursively; no runaway expressions
- **Strict about undeclared keys** — reading an undeclared state key is a hard error

```typescript
type Expr =
  | { op: "const"; value: string | number | boolean | null }
  | { op: "var"; key: string }
  | { op: "eq" | "ne" | "lt" | "lte" | "gt" | "gte"; left: Expr; right: Expr }
  | { op: "and" | "or"; clauses: Expr[] }
  | { op: "not"; clause: Expr };
```

This is the explicit replacement for `eval()`. There is no `eval` anywhere in
genesis-new. Conditional logic is data interpreted by a fixed runtime, not executed
code.

---

## Layer 3 — The Capability Plane (`src/core/capability/capability.ts`)

The admission gate and the supervisor. The two security decisions that matter most.

### `admit()` — pure admission (no I/O)

```
admit(node, call, estimateCents, runBudgetCents, budget) → Admission
```

Checks, in order:
1. **Capability granted?** — is the requested capability in `node.capabilities`? If not: `CAPABILITY_NOT_GRANTED`. Deny-by-default.
2. **Run budget OK?** — `spent + reserved + estimate ≤ runBudgetCents`? If not: `RUN_BUDGET_EXCEEDED`.
3. **Node cap budget OK?** — same check against the per-capability ceiling. If not: `NODE_CAP_BUDGET_EXCEEDED`.
4. **Requires approval?** — derived from `node.autonomy` and `capability.sideEffect`:
   - `suggest` → always ask for any side effect
   - `act-with-veto` → ask for irreversible/spend/identity; proceed for reversible writes
   - `full` → never ask

Reserve-then-settle: the estimate is reserved at admission time; the real cost
is settled from the `EffectResult` the supervisor signs. This means you can never
overspend at run time — the ceiling is enforced before dispatch, not after.

### `Supervisor` — the only impure code in the capability plane

```typescript
class Supervisor {
  async run(call: EffectCall, idem: string): Promise<ObservedEffect>
}
```

The supervisor **runs the plugin** and **co-signs the result**. The plugin never
signs its own result — that would let a malicious plugin self-report a lower cost
or fake an output. The supervisor records:
- `costCents` — what it *observed* (supervisor-attested)
- `output` — what the plugin returned
- `pluginClaim` — the plugin's own report, kept as explicitly-untrusted data

The `EffectResult` event is signed by the **supervisor's key**, not the plugin's
key. This trust boundary is structural, not doctrinal.

### `idempotencyKey()` — deterministic after a crash

```typescript
idempotencyKey(call) = `${nodeId}:${capability}:${contentAddress(canonical({nodeId, capability, input}))}`
```

The key is derived from the call's inputs, not from a random UUID. If the process
crashes and restarts with the same manifest and same inputs, the key is identical,
so the engine re-serves the existing result instead of re-running the effect.

---

## Layer 4 — The Kernel and Engine (`src/core/kernel/`)

### `kernel.ts` — the pure kernel

```typescript
decide(manifest: Manifest, projection: RunProjection, declared: Set<string>) → Decision
```

Pure. No I/O. Given the manifest and the folded run state, it returns the single
next thing to do. The engine carries it out and appends events; then the kernel is
asked again. This is "execution is a reduction over the log."

Decisions:

```typescript
type Decision =
  | { kind: "start" }
  | { kind: "enter"; nodeId: string }
  | { kind: "runNode"; nodeId: string }
  | { kind: "conclude"; nodeId: string }
  | { kind: "advance"; fromNodeId: string; toNodeId: string }
  | { kind: "complete" }
  | { kind: "halt"; reason: string; holes?: string[] }
  | { kind: "fail"; reason: string };
```

Decision logic in order:
1. **Crash holes first.** If any `EffectRequested` has no matching `EffectResult`,
   that is a crash hole → `halt`. Never auto-proceed past an unresolved effect.
2. **If not started** → `start`.
3. **Find current node** (entered but not concluded). If none, enter the entry node.
4. **Loop bound** — if a node has been visited `maxNodeVisits` times → `fail`.
5. **Node in progress (entered, not concluded)** → `runNode`.
6. **Node concluded** → evaluate outgoing edges (using the safe expr evaluator)
   → `advance` to the first matching edge, or `complete` if none.

### `project.ts` — the run projection (a pure fold)

`project(events) → RunProjection` folds the ledger into the live run state:

```typescript
interface RunProjection {
  started: boolean;
  completed: boolean;
  failed: boolean;
  nodes: Record<string, { entered: boolean; concluded: boolean; visits: number }>;
  resultsByIdem: Map<string, unknown>;  // for re-serve
  budget: BudgetState;                  // spent + reserved, per cap
  state: Record<string, unknown>;       // run-state for edge conditions
}
```

`crashHoles(projection)` returns the idempotency keys of any `EffectRequested`
events that have no matching `EffectResult` — these are the crash holes the kernel
checks first.

### `engine.ts` — the thin impure shell

The engine is the **only code that touches the world**. It loops:
1. Fold the log → `RunProjection`
2. Ask the kernel → `Decision`
3. Carry out the decision (append events, run effects via supervisor)
4. Repeat until terminal

The 3-event effect protocol inside `runNodeBody`:
1. Check if the effect's idempotency key already has a result → **re-serve** (skip).
2. Call `admit()` → append `AdmissionDecision`.
3. If approval required and `approve(call)` returns false → append `AwaitRequested`, halt.
4. Append `EffectRequested`.
5. Run via `supervisor.run()` → append `EffectResult` (supervisor-signed, `determinism: "captured"`).
6. Re-fold `p` so the budget reflects this effect before the next call.

After all calls in a node: append `NodeConcluded`.

---

## Layer 5 — The Compiler (`src/core/compiler/compiler.ts`)

The trust boundary between the LLM and the system.

The LLM is an **untrusted frontend**. It proposes a manifest — a structured
data object — and the compiler is what decides whether that proposal is acceptable.

Compilation is four steps:

1. **Ask the model** (`ModelPort.propose(intent)`) → a `ManifestProposal` (same
   shape as `Manifest`, but untrusted data, not executable)
2. **Structural validation** (`validateManifest`) — dangling edges, bad entry, etc.
3. **Capability monotonicity** — the security core
4. **Sign with provenance** — who compiled it, from what intent, at what time

### Capability monotonicity (the prompt-injection fix)

```
checkMonotonicity(manifest, principal) → ValidationIssue[]
```

The `Principal` carries the *maximum* capabilities and budget it is allowed to
confer. The compiler verifies that the proposed manifest does not exceed those
maximums — not just in total, but per capability, per side-effect class, per budget
ceiling.

If an injected prompt in a channel message tries to request `spend` capability or
a higher budget, it fails here — the channel principal simply isn't allowed to
confer those grants, regardless of what the LLM proposed. An untrusted origin can
never widen scope. This is structural, not a content filter.

```typescript
interface Principal {
  kind: "owner" | "channel" | "agent" | "memory";
  id: string;
  allowedCapabilities: AllowedCapability[];
  maxRunBudgetCents: number;
}
```

`"owner"` can grant anything. `"channel"`, `"agent"`, `"memory"` can only grant
subsets of what the owner has pre-allowed.

### The `ModelPort` — the swappable LLM interface

```typescript
interface ModelPort {
  propose(intent: string): Promise<ManifestProposal>;
}
```

The model is behind a port. `src/adapters/anthropic-model.ts` implements this
using the Anthropic API (built-in `fetch`, no SDK dependency). Tests inject a
`FakeModelPort`. Switching to GPT-4 or Gemini requires only a new adapter file.

---

## Layer 6 — Identity & Secrets (`src/core/identity/identity.ts`)

### Key lifecycle

`IdentityManager` wraps the `HmacKeyring` with lifecycle:
- **`issue(keyId, secret, now)`** — registers a new key (epoch 1)
- **`rotate(keyId, newSecret, now)`** — closes old epoch at `now`, opens new epoch. Signatures made before `now` remain valid (history is immutable). New signing uses the new epoch.
- **`revoke(keyId, now)`** — closes the window at `now`. Pre-`now` signatures verify; post-`now` ones don't.

Keys have a validity window `[validFrom, validUntil)`. The keyring's `verify()` checks that the event's `ts` falls inside the signing key's window — so a revoked key can't sign new events, but old legitimate events still verify.

### Secret broker

Secrets never touch plugins. A plugin asks the broker for a **short-lived, scoped
token** bound to a specific destination and capability. The broker mints the token;
the underlying secret stays in the broker. If a plugin is compromised, it can only
access what it was granted a token for, and only for the token's lifetime.

---

## Layer 7 — Memory (`src/core/memory/memory.ts`)

Memory is **not a separate database**. It is a projection of memory events on the
one ledger. What an agent "knows" is always replayable and provably equals what
happened.

### Four planes

| Plane | Scope | Description |
|---|---|---|
| **Working** | Per-run scratch | Folded per run; never persisted beyond it |
| **Episodic** | Per-run summaries | What happened in a run; owned by the agent |
| **Semantic** | Durable facts | Distilled across episodes with provenance; LLM-distilled (captured) |
| **SOUL** | Agent identity | Name, values, standing instructions; versioned; owner-authority only |

### Provenance and the untrusted-inbound gate

Every memory fact carries a `Provenance`:
```typescript
type Provenance = "owner" | "tool-observed" | "channel" | "agent" | "memory";
```

Only `"owner"` and `"tool-observed"` are trusted. Facts arriving via channel
messages, other agents, or memory recall are **quarantined** — they may inform
reads, but they may NOT influence a `spend`, `write-irreversible`, or
`identity-mutation` decision unless an owner explicitly re-passes them through
the autonomy gate. This closes the "laundering instructions across runs" hole.

### Distillation is a captured effect

Semantic facts are produced by an LLM distillation step. That step is
non-deterministic, so its output is recorded as a `"captured"` effect result —
tagged with the model and version that produced it. Observability never tries to
hash-reconcile a captured result; it re-serves it on replay.

---

## Layer 8 — Channels & Interaction Resolver (`src/core/channels/channel.ts`)

### Channel adapters are stateless and untrusted

A `ChannelAdapter` (Telegram, Slack, web) is just a transport:
```typescript
interface ChannelAdapter {
  readonly name: string;
  send(threadId: string, text: string): Promise<string>;
}
```

It holds no conversational state, no secrets, no manifest access. It emits inbound
messages as DATA (`InboundMessage`). Conversation state lives in the ledger, keyed
by `(principalId, threadId)`.

### The Interaction Resolver — the trusted enforcement point

The `InteractionResolver` is the single place that approves effects:

1. **Single-use correlation tokens** — each approval request carries a unique token. Once resolved (approved or denied), `open = false`. Replaying the same message cannot re-approve.
2. **Branch-scoped** — a token is bound to a `branchId`. A reply on a different branch is rejected (`BRANCH_MISMATCH`).
3. **Identity assurance gate** — each effect class has a minimum assurance level:
   - `read` / `write-reversible` / `message-human` → `"low"`
   - `write-irreversible` → `"medium"`
   - `spend` / `identity-mutation` → `"high"`
   A low-assurance channel (recycled phone number, SMS with spoofable sender) cannot authorize a `spend` without step-up.
4. **Approval IS authorization** — resolving to `"authorized"` doesn't just flag "yes"; it resolves the parked `AwaitResolved` event AND would mint the matching capability grant atomically in the ledger.

---

## Layer 9 — Observability (`src/core/observability/observe.ts`)

All views are **pure folds** of the ledger. Zero ambient authority: no I/O, no clock, no eval.

### Three live views

```typescript
canvasView(projection)  → { nodes: [{ id, status, visits }] }
costView(events)        → { spentCents, reservedCents, byEffect }
timelineView(events)    → [{ offset, scope, type, author }]
```

The canvas is a fold, not a rendering of a separate graph structure. It cannot
drift from what actually executed.

### Two replay modes

**Verification replay** (`verificationReplay`):
- Re-verifies the entire hash chain (catches any corruption)
- Recomputes cost purely from the log
- If chain doesn't verify → `UNVERIFIABLE` (loud), never silent
- Zero side effects — can be run at any time without risk

**Counterfactual replay** (`planCounterfactual`):
- Forks the run at a given node
- Identifies every downstream effect that *would* re-gate through admission
- Returns `projectedCostCents` — what a real fork would cost
- **Does not execute anything** — the UI shows projected cost; nothing is charged
- A "what if" branch cannot silently re-spend money or re-send messages

---

## Layer 10 — Model Adapter (`src/adapters/anthropic-model.ts`)

Implements `ModelPort` against the Anthropic API.

- Built-in `fetch` only — no `@anthropic-ai/sdk` dependency
- The model's output is treated as **untrusted data**. It is a `ManifestProposal`
  that then goes through the compiler's validation + monotonicity check. The model
  cannot bypass those checks by crafting a clever response.
- Tested live: a real Anthropic call proposed a 3-node workflow; the compiler signed
  it within authority; the engine ran it; the ledger verified it.

---

## The security invariants (all structural, not doctrinal)

| Guard | What it prevents | Where enforced |
|---|---|---|
| No `eval` | RCE via crafted edge conditions | `expr.ts` — typed AST evaluator only |
| Deny-by-default capabilities | A node calling what it wasn't granted | `admit()` in `capability.ts` |
| Budget-before-spend | Overspend at run time | `admit()` — reserve at admission, settle from result |
| Plugins never self-sign | Faked costs or outputs | `EffectResult` signed by supervisor key only |
| Secrets never touch plugins | Secret exfiltration via plugin | Secret broker mints scoped tokens |
| Capability monotonicity | Prompt injection escalating grants | `checkMonotonicity()` in compiler |
| Single-use approval tokens | Replay attacks via channel | `InteractionResolver` marks `open = false` |
| Assurance-gated approval | Low-assurance channel approving spend | Per-effect-class assurance requirement |
| Crash holes HALT | Double-execution of irreversible effects | `crashHoles()` checked first in kernel |
| Untrusted-inbound quarantine | Laundering instructions across runs | Provenance gate in memory folds |

---

## What's built vs. what's next

### Built and verified (490/490 tests, typecheck clean)

| Subsystem | Files | Status |
|---|---|---|
| Ledger (in-memory + SQLite) | `src/core/ledger/` | ✅ |
| Identity / Secrets / Time | `src/core/identity/` | ✅ |
| Capability plane | `src/core/capability/` | ✅ |
| Manifest + safe expressions | `src/core/manifest/` | ✅ |
| Pure kernel + engine | `src/core/kernel/` | ✅ |
| NL→Manifest compiler | `src/core/compiler/` | ✅ |
| Memory (4 planes) | `src/core/memory/` | ✅ |
| Channels + resolver | `src/core/channels/` | ✅ |
| Observability | `src/core/observability/` | ✅ |
| Anthropic model adapter | `src/adapters/` | ✅ live-tested |

### Not yet built

| What | Why it's next |
|---|---|
| Web UI / canvas (`web/`) | The visible "wow" — canvas, live trace, audit, time-travel |
| Postgres store adapter | Multi-tenant / hosted scale (same `LedgerStore` port) |
| MCP tool adapter | Open ecosystem — any MCP server becomes a usable capability |
| Telegram / Slack channel adapter | Conversational interface; needed for the live demo |

---

## Running it

```bash
cd /Users/sreenath/Code/myAIExps/genesis-new
npm install
npm run typecheck        # strict TS, should be clean
npm test                 # 490/490 (1 test requires Ollama and skips without it)

npm run demo:ledger      # canvas + cost + audit all fold from one log
npm run demo:resume      # kill mid-run; each irreversible effect runs exactly once
npm run demo:e2e         # real 3-agent pipeline drives itself off the ledger
npm run demo:compile     # intent → compiled+signed manifest → run
npm run demo:live        # (needs KRELVAN_ANTHROPIC_KEY) real Anthropic model call
```

Web UI (`web/`): `localhost:3100` — built (landing + NL builder, dashboard, runs,
run detail with diagnosis + retry-with-fix, agent detail, interactive canvas,
capabilities marketplace, MCP, approvals, schedules).

---

*Last updated: 2026-06-06*
*Status: core complete; web UI is next*
