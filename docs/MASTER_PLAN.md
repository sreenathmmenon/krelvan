# Krelvan — Master Plan & Journey

*(Krelvan was previously called "Genesis"; the original Python proof-of-concept it grew
from still lives at `../genesis` and is referenced below as part of the journey.)*

*The single document that captures everything: what we're building and why, the full
arc of how we got here, the current architecture, where we stand right now (honestly),
where we're going, and what's next. Start here.*

*Last updated: 2026-06-03.*

---

## 1. The aim (in one paragraph)

Build the platform that lets **anyone — a person, a team, an enterprise — own, run,
and trust their own AI agents.** You describe an outcome in plain language; the system
generates, validates, signs, and runs a real multi-agent workflow. Phase 1 is
self-host-and-own-it (download one thing, runs offline, you own your data); a hosted
option comes later on the *same* core, never a fork. The decisive differentiator is
not "another agent builder" — it is **trust made legible**: every action an agent
takes is recorded, verifiable, reversible, and can never silently spend your money or
exceed what you allowed.

Success is measured by three things, in priority order: **(1) adoption / install
base, (2) becoming attractive enough to be acquired by a major AI company, (3)
long-term maintainability.**

---

## 2. The journey — how we reached this design

This was not a straight line. The path mattered, so here it is honestly.

1. **Started from the existing project** (`../genesis`): a working Python/FastAPI +
   LangGraph + Next.js platform, built in ~2 days, deployed on Railway. It works:
   5 meta-agents turn an intent into a real LangGraph workflow that runs on demand /
   on a schedule / via Telegram. We validated it live (32 workflows, runs completing,
   real output) and fixed real production bugs (Telegram Markdown crash, an
   over-spending monitor, a model that rejected a parameter, fabricated data).

2. **Stepped back to strategy.** The question shifted from "fix the demo" to "where
   does this go?" We did real competitive research: the agent-platform space is
   *fragmented* — no one owns "describe an outcome → a deployed, multi-agent,
   always-on system that you OWN." The closest players (Sierra, OpenAI AgentKit,
   Lindy) are all walled off, rented, or vendor-locked.

3. **Found the real thesis.** Not "be like a CMS with plugins" — that was a misread.
   The real model is *democratization*: take a capability that needed specialists and
   make it ownable by everyone, the way earlier platforms democratized publishing,
   design, e-commerce. The five conditions for that kind of shift: collapse all the
   gates at once (cost/skill/time/permission), **ownership not rental**, one core
   from novice to enterprise, a smooth no-cliff ladder, and an open ecosystem. Agents
   add a sixth gate no prior wave faced: **verifiable trust + predictable cost.**

4. **The key reframe.** The current code was written by AI in 2 days — and the future
   will be the same or faster. So *rewrite cost is no longer a real constraint*. We
   optimize for what is RIGHT for the 10-year arc — what compounds, what avoids
   lock-in — not for what is cheap to build now.

5. **Multi-perspective councils** (run as multi-agent workflows): an expert panel
   debated the stack and the internal architecture from five angles each
   (infra, OSS-founder, AI-researcher, enterprise-CTO, pragmatist), cross-examined,
   then synthesized. The councils converged on a clean-sheet design and, notably,
   **every subsystem independently refused to build on LangGraph as the substrate.**

6. **Locked the architecture and started building** a fresh TypeScript core
   (`genesis-new`), bottom-up, each layer proven by tests before the next. We also
   established the working discipline: a 435-item premortem, a "no bluffing" rule
   (only claim what was actually run), zero IP risk, and a verified design system.

The full reasoning lives in `../genesis/docs/`: THE_GENESIS_MOMENT (the why),
TARGET_ARCHITECTURE & INTERNAL_ARCHITECTURE (the what), ARCHITECT_FUTURE_PLAN (the
stack decision), REFRAME_AI_BUILDS_IT (the lens), CURRENT_ARCHITECTURE (the old
system as-is), and STACK_COUNCIL_VERDICT.

---

## 3. The architecture (what we decided, and why)

### The one principle
> **The ledger IS the runtime.** Execution is a projection of an append-only,
> content-addressed, signed event log. The canvas, audit timeline, and
> memory are all pure *reads* (folds) of that one log. So "what you see is exactly
> what executed" is a structural guarantee, not a hope. Replay, resume, and undo come
> for free; nothing can drift out of sync with reality.

### The model
- **The program is a declarative, model-agnostic Manifest** the user owns (intent +
  policy + capability-references — never prompts or model calls). It survives every
  model generation because it names no model.
- **The LLM is a compiler (NL → manifest) and a plugin — never the substrate.** The
  model is the most disposable layer; the manifest + ledger are what compound.
- **A pure kernel + a thin impure engine.** `decide(manifest, ledger) → events` is
  pure; the engine is the only code that touches the world (runs effects, appends
  events). LangGraph is at most an optional sandboxed adapter, never the spine.
- **Everything is a swappable port** (model, vector store, tools via MCP, channel,
  durable backend, store) with a sane default in the box. The core owns as little as
  possible. This is the "bring your own GPT / Qdrant / plugin" property.

### The stack (clean-sheet, council verdict)
- **Core language: TypeScript** — biggest contributor/plugin pool (adoption),
  mainstream + typed (acquisition + maintainability). Python's only edge is AI
  libraries, which live in the *pluggable* layer, so they come in as plugin sidecars.
- **Zero third-party runtime dependencies in the core** — Node built-ins only
  (`node:crypto`, `node:sqlite`, `fetch`). License-clean, tiny to self-host.
- **Data: Postgres-for-everything** (later), with an **embedded SQLite default** so it
  runs offline in minute one. RLS tenant-of-one from row zero.
- **Durability: the ledger's own event-replay** (DBOS-style on Postgres later);
  no Temporal cluster forced on a self-hoster.

### The non-negotiable security decisions
- **No `eval`, ever** — conditional logic is a typed AST evaluator; generated agent
  logic is DATA interpreted by a fixed runtime, never executed code.
- **Plugins never self-sign** facts about their own behavior — a supervisor co-signs
  what it mechanically observed. **Secrets never touch plugins** (a broker mints
  scoped tokens).
- **Capability monotonicity** — an untrusted/injected intent can never widen grants
  (the front-door fix for prompt injection).
- **Deny-by-default + budget-before-spend** — nothing runs ungranted or over budget.
- **Identity/Secrets/Time is first-class** — key rotation/revocation, a monotonic
  notarized clock (no raw `Date.now()` in the core, so replay stays deterministic).

### The "wow"
Provably-honest **time-travel**: scrub a live run backward and see the agent's exact
past state (memory is a fold; retrieval was captured). **Counterfactual replay** forks
a branch and *re-gates every effect* through admission — so a "what if" can never
accidentally re-spend money or re-send messages. Agents **earn autonomy by passing
evals**. The visual canvas maps 1:1 to the executing graph.

---

## 4. Where we are RIGHT NOW (honest, verified)

Two codebases exist:

### `../genesis` (the original) — LIVE, working
The Python/LangGraph/Next.js platform, deployed on Railway, with the full prior
journey documented in its `docs/`. Still runs. This is the proof-of-concept and the
source of all the strategy docs.

### `genesis-new` (the future core) — built bottom-up, TypeScript
**Verified state: 167/170 tests pass (3 are live-model API tests that need a key), typecheck clean, 0 runtime dependencies in core.**
Built and proven (each by passing tests + runnable demos):

| Subsystem | What it does | Status |
|---|---|---|
| **Ledger** | content-addressed, hash-chained, signed events; `verify()` catches every corruption | ✅ tested |
| **SQLite durable store** | real on-disk crash/resume behind the same port | ✅ tested |
| **Identity/Secrets/Time** | key rotation/revocation, secret broker, monotonic clock | ✅ tested |
| **Capability plane** | deny-by-default, budget ceilings, supervisor co-signs | ✅ tested |
| **Manifest + safe expr** | typed AST conditional edges, never eval | ✅ tested |
| **Pure kernel + engine** | 3-event effect protocol, crash-hole HALT, resume | ✅ tested |
| **NL→manifest compiler** | capability monotonicity (prompt injection can't escalate) | ✅ tested |
| **Memory** | 4 planes, distillation provenance, untrusted-inbound gate | ✅ tested |
| **Channels + resolver** | approval IS authorization, single-use tokens, assurance levels | ✅ tested |
| **Observability** | verification + counterfactual replay, cost reconciliation | ✅ tested |
| **Anthropic model adapter** | real LLM proposes manifests; output untrusted + validated | ✅ live-tested |

**Five runnable demos** (all pass): `demo:ledger`, `demo:resume` (crash→resume, each
irreversible effect exactly once), `demo:e2e` (a real multi-agent run off the ledger),
`demo:compile` (intent→signed manifest→run), `demo:live` (a REAL Anthropic call →
proposed workflow → compiled within authority → ran → verified).

**Not yet built:** the web UI / visual canvas, and a Postgres (multi-tenant scale)
store adapter.

### Discipline in place
- `docs/PREMORTEM.md` — 435 enumerated failure modes; ~40 GUARDED (each tied to a
  passing test), the rest honestly UNADDRESSED. A subsystem is "done" only when its
  section is GUARDED or WAIVED.
- `docs/LEDGER_SPEC.md` — the ledger contract + edge-case checklist.
- `docs/DESIGN_SYSTEM.md` — the UI foundation, calibrated to sarvam.ai's *real*
  extracted palette (cool near-white canvas, indigo-navy ink, green accent; never
  dark; one spacing scale; anti-overlap / anti-cramming rules).
- `AGENTS.md` — the rules any agent/human must follow in this repo (no bluffing, no
  eval, pure-kernel, no IP theft, git authorship, etc.).

---

## 5. Where we're going (the roadmap)

**Immediate next: the web UI.** Built against `docs/DESIGN_SYSTEM.md`. The visible
"wow": the canvas where the graph you watch being drawn is the graph that executes,
the live ledger-folded trace, the signed audit timeline, the autonomy/approval
controls, and time-travel/counterfactual replay. Light, clean, spacious, sarvam-
calibrated.

**Then, to close the functional loop into a usable product:**
- Wire the real model adapter + compiler + engine behind a small API the UI calls.
- A Telegram (and later Slack/web) channel adapter on the new core, so an agent is
  reachable conversationally — the live-demo requirement.
- The Postgres store adapter + RLS for multi-tenant / hosted scale (same port).
- An MCP tool adapter so any MCP server is a usable capability (the open ecosystem).

**Then, the platform plays (the moat):**
- A shareable, signed Manifest format + a trusted registry — the open standard others
  build on. Adoption + ecosystem + install base is the acquisition magnet.
- The autonomy ladder as a first-class product primitive (suggest → approve →
  supervised → autonomous), trust earned by passing evals.

**Always, in parallel:** drive the premortem to GUARDED/WAIVED before any subsystem is
called done; keep zero IP risk; keep "no bluffing."

---

## 6. What's next (the very next concrete step)

**Build the web UI**, starting from the design system, in this order:
1. A `globals.css` / tokens file materializing `DESIGN_SYSTEM.md` (colors, type,
   spacing) — the contract every component uses.
2. The shell (light, spacious layout) + the **run trace view** (the ledger folded
   into a live, verifiable timeline) — this is the most direct
   expression of "the ledger is the runtime."
3. The **canvas** (graph = the executing manifest, auto-laid-out so nodes never
   overlap) + the **approval/autonomy** controls.
4. The **describe-an-outcome** entry (intent → compiler → signed manifest → run),
   wired to the real model adapter.

Each screen must pass the design-system checklist (one primary thing, nothing
overlaps, mostly near-white+ink, detail one click away).

---

## 7. The one-line summary

> Krelvan: describe an outcome, get a real agent you OWN — where a signed event ledger
> IS the runtime, the manifest is the portable program, the LLM is a swappable
> compiler-and-plugin, every action is verifiable and reversible, and it can never
> spend your money by accident. Built clean-sheet in TypeScript, proven bottom-up
> with tests, self-host first. Next: the UI that makes the magic visible.
