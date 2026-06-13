# Genesis vs the Field

*Based on a full reading of every source file in genesis-new. No claims about what
is "coming" — only what the code actually implements today.*

---

## The one-line pitch

Genesis is the only agent platform where **the execution log IS the runtime** —
no separate state store, no inference about what happened, no way for the UI to
lie about what executed. Every view is a cryptographic fold of a single
append-only ledger.

---

## Head-to-head: Architecture

| Property | Genesis | LangGraph | Mastra | Temporal |
|----------|---------|-----------|--------|----------|
| State model | Append-only signed ledger (fold) | Mutable state dict per run | Mutable per-run context | Event-sourced workflow history |
| Determinism guarantee | Same events → same state (I8) | Not guaranteed | Not guaranteed | Replay deterministic |
| Tamper evidence | SHA-256 hash chain + HMAC per event | None | None | None |
| Crash recovery | Re-fold ledger, continue | Checkpoint/restart | Checkpoint | Replay from history |
| Side-effect protocol | 3-event: AdmissionDecision → EffectRequested → EffectResult | Direct call | Direct call | Activity result recorded |
| Double-execution prevention | Idempotency key on every effect | Not built-in | Not built-in | At-most-once via history |
| Budget enforcement | Pre-dispatch: reserve → settle; per-capability ceilings | None | None | None |
| Privilege model | Deny-by-default, capability monotonicity | None | None | None |
| Plugin trust | Supervisor co-signs (plugin never self-signs) | No signing | No signing | No signing |
| Expression evaluation | Typed AST evaluator (zero eval) | Python exec | JS/TS eval paths | No user expressions |
| Memory architecture | 4 planes folded from ledger (working/episodic/semantic/soul) | External (LangSmith) | External | External |
| Self-host | Yes — single Node process, SQLite, no cloud deps | Partial | Yes (complex) | Yes (complex infra) |
| Third-party core deps | Zero | Many | Many | Many |

---

## Head-to-head: Developer experience

| Property | Genesis | LangGraph | Mastra | Replit/Lovable/v0 |
|----------|---------|-----------|--------|-------------------|
| Define agent | Natural language → signed manifest | Python/JS graph code | TypeScript graph code | UI/chat |
| Build preview | Full graph + node/capability list before running | None | None | Output preview |
| Self-correction | Up to 3 compile attempts with feedback | N/A | N/A | Iterative prompts |
| Run observation | Scrub through events step-by-step on canvas | Log viewer | Log viewer | None |
| Cost breakdown | Per-effect, integer cents, in UI | Token count only | Token count only | None |
| HITL | Branch-scoped, single-use, assurance-gated | Manual polling | Manual polling | None |
| Memory inspection | Episodic + semantic + soul tabs in UI | External tooling | External tooling | None |
| Capability install | YAML/JS plugin + API or UI upload | Code only | Code only | None |
| MCP integration | Auto-discovery (any MCP server → plugin) | Manual | Manual | None |
| Scheduling | Cron + interval, persists across restarts | External | External | External |
| Explain run | LLM narrates what the ledger shows | None | None | None |

---

## What Genesis does that nothing else does

### 1. Capability monotonicity

When a user's intent compiles to a manifest, the compiler enforces that a
non-owner principal (a channel message, an agent reply, a memory recall) can
**never widen** the capability grants in the manifest. An attacker who gets their
text into the agent's input cannot instruct the agent to acquire new permissions
or increase budget ceilings. The trust boundary is at compile time, not at
inference time.

**Code:** `src/core/compiler/compiler.ts` — `checkMonotonicity()`

### 2. Evidentiary canvas

The canvas (and every other view: cost meter, timeline, memory) is a **pure fold
of the ledger**. There is no in-process state that the UI reads; it literally
re-folds the event log on every render. This means:

- You cannot have a canvas that shows a node as "done" if the ledger does not
  contain a NodeConcluded event for it
- You cannot have a cost display that disagrees with the ledger
- A tampered ledger is detected (hash chain breaks) — the UI shows UNVERIFIABLE

**Code:** `src/core/observability/observe.ts`, `src/core/kernel/project.ts`

### 3. Crash-hole safety

The kernel will never proceed past an unresolved `EffectRequested` event. Before
every decision, it calls `crashHoles(projection)` — if any effect was requested
but no result was recorded, the kernel returns `"halt"`. The engine cannot
accidentally skip a side effect or double-execute it. This is architectural, not
a try/catch.

**Code:** `src/core/kernel/kernel.ts`, `src/core/kernel/project.ts` —
`crashHoles()`

### 4. Budget enforcement with reserve-then-settle

Every effect goes through: estimate → reserve (atomic, counted against ceiling) →
execute → settle actual cost. Over-budget effects are denied before the network
call is ever made. Per-capability ceilings and run-level ceilings are both
enforced. This is in `decide()` — the pure kernel — not in a side channel.

**Code:** `src/core/capability/capability.ts` — `admit()`

### 5. Signed manifest provenance

Every agent is a **signed manifest** (SHA-256 content address + HMAC signature)
with embedded provenance: who compiled it, from what natural language intent, at
what time. The manifest cannot be silently modified; a hash mismatch is detected
on load. This is the trust anchor for the entire execution.

**Code:** `src/core/compiler/compiler.ts` — `SignedManifest`

### 6. Sub-agent composition with budget delegation

A capability in a node can be backed by a full sub-run of another agent. The
parent reserves budget for the sub-run capability, the sub-run executes (with its
own ledger scope), and the parent settles the actual cost. The sub-agent cannot
exceed the delegated budget. This is composable agent systems, not just
sequential tool calls.

**Code:** `src/core/kernel/sub-agent-executor.ts`, `src/core/kernel/engine.ts`

### 7. Four-plane memory with trust gates

Agent memory has four planes: working (scratch), episodic (run summaries),
semantic (distilled facts), soul (identity). All are folded from the ledger.
Crucially, the **untrusted-inbound gate** ensures that facts arriving via
untrusted channels (messages, agent replies) can inform reads but cannot influence
spend/write-irreversible/identity-mutation operations. Memory laundering across
runs is structurally prevented.

**Code:** `src/core/memory/memory.ts`

---

## What LangGraph has that Genesis doesn't (yet)

- **Graph visualizer with editing**: LangGraph Studio lets you edit the graph
  visually. Genesis canvas shows the graph but doesn't support dragging nodes yet.
- **LangSmith integration**: deep tracing, evaluation, dataset management.
  Genesis has its own observability but no external evaluation suite.
- **Streaming tokens**: LangGraph surfaces token-level streaming. Genesis records
  full results.
- **Ecosystem size**: many more community examples, templates, adapters.

## What Temporal has that Genesis doesn't (yet)

- **Multi-tenant scale**: Temporal has production-proven multi-tenant infrastructure.
  Genesis runs on SQLite today; Postgres adapter is designed but not coded.
- **Language polyglot**: Temporal supports Go/Java/Python/TypeScript workers.
  Genesis is TypeScript only.
- **Battle-tested durability**: Temporal has years of production load. Genesis's
  SQLite store is crash-safe but not yet proven at scale.

## What Mastra has that Genesis doesn't (yet)

- **Vercel/Next.js native deployment story**: Mastra integrates tightly with
  Vercel edge functions.
- **RAG pipeline primitives**: Mastra has built-in vector store integration.
  Genesis has semantic memory but not a general RAG pipeline.

---

## What Replit/Lovable/v0 do that Genesis doesn't try to do

These tools generate *code* from natural language. Genesis generates *agent
systems* — signed, budget-enforced, auditable programs with explicit capability
grants that execute against a verifiable ledger. They solve different problems.
The builder UI surface looks similar but the trust model is entirely different.

---

## Summary

Genesis's bet: **trust is the moat.** Most platforms assume the agent is benign
and build features on top. Genesis builds from the opposite assumption — the model
is an untrusted data source, every side effect must be admitted, every cost must
be reserved before spending, every event must be signed, and the UI must be a fold
of the ledger rather than an independent process that could lie.

That bet pays off in two situations: enterprises that need an auditable record of
what their agents did, and multi-agent systems where sub-agents could attempt to
escalate privileges or exceed delegated budgets.

The cost: more infrastructure in the core (the ledger, the 3-event protocol, the
admission layer), slower initial development than gluing LangChain together. The
benefit: every invariant is structural, not a convention.
