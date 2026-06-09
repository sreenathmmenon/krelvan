# Genesis (core)

*Own, run, and trust your own AI agents. The ledger is the runtime.*

This is the ground-up TypeScript core, built to the target architecture in
`../genesis/docs/` (ARCHITECT_FUTURE_PLAN, TARGET_ARCHITECTURE, INTERNAL_ARCHITECTURE).
It is being built bottom-up, each layer proven by tests before the next.

## The one principle

**The ledger IS the runtime.** Execution is a projection of an append-only,
content-addressed, signed event log. The canvas, the cost meter, and the audit
timeline are all *reads* (folds) of that one log — so "what you see is exactly what
executed" is structural, not hopeful.

## What's built and proven (run it yourself)

```
npm install
npm run typecheck    # strict TS, clean
npm test             # 82/82 passing
npm run demo:ledger  # the inversion: canvas + cost + audit all fold from one log
npm run demo:resume  # kill mid-run, resume, each irreversible effect runs EXACTLY once
npm run demo:e2e     # a real 3-agent pipeline drives itself off the ledger
npm run demo:compile # intent -> compiled+signed manifest -> run; untrusted principal rejected
npm run demo:live    # (needs GENESIS_ANTHROPIC_KEY) a REAL model proposes a workflow,
                     # compiler signs it within authority, engine runs it, log verifies
```

### Layers in place

| Layer | Files | Proven by |
|---|---|---|
| **Ledger** | `src/core/ledger/` | canonicalization (no floats), content-addressing, hash-chaining, signed events w/ key windows, CAS append (no forks), `verify()` catches every corruption, tail-truncation via checkpoints |
| **Manifest** | `src/core/manifest/manifest.ts` | structural validation (dangling edges, bad entry, budgets) |
| **Safe expressions** | `src/core/manifest/expr.ts` | conditional edges are a typed AST evaluator — **never `eval`**; undeclared keys are hard errors |
| **Capability plane** | `src/core/capability/capability.ts` | deny-by-default admission, reserve-then-settle budget ceilings, autonomy gradient, supervisor co-signs results (**plugins never self-sign**) |
| **Pure kernel** | `src/core/kernel/kernel.ts`, `project.ts` | `decide(manifest, projection)` is pure; crash-hole HALT; loop bound |
| **Engine** | `src/core/kernel/engine.ts` | the only impure code; 3-event effect protocol; crash-safe resume, no double-execution |

## Design principles (invariants every change respects)

1. **The ledger is the only source of truth.** Everything else is a pure fold of it.
2. **The kernel is pure; the engine is the only thing that touches the world.**
3. **No `eval`, ever.** Conditional logic is a restricted, total AST evaluator.
4. **Deny-by-default + budget-before-spend.** An effect not granted, or over budget,
   never runs. Cost is exact integer cents (no floats in the ledger).
5. **Plugins are untrusted.** The supervisor co-signs what it observed; a plugin's
   self-report is explicitly-untrusted data.
6. **Crash-safe by construction.** State lives only in the log; resume = re-fold.
7. **No external dependencies in the core** (Node built-ins only) — license-clean and
   small to self-host.

## Quality discipline

- `docs/LEDGER_SPEC.md` — the ledger contract, invariants, and edge-case checklist.
- `docs/PREMORTEM.md` — 435 enumerated failure modes; each carries a guard and a
  status. Items flip to GUARDED only when a real passing test covers them. A
  subsystem is not "done" until its section is GUARDED or explicitly WAIVED.

## Status — honest

Built & verified (73 tests pass, typecheck clean):
- **Ledger** + **SQLite durable store** (real on-disk crash/resume)
- **Identity, Secrets & Time** (key rotation/revocation, secret broker, monotonic clock)
- **Capability plane** (deny-by-default, budget ceilings, supervisor co-signs)
- **Manifest + safe expressions** (typed AST, never eval)
- **Pure kernel + engine** (3-event effect protocol, crash-hole HALT, resume)
- **NL→manifest compiler** (capability monotonicity — prompt injection can't escalate)
- **Memory** (4 planes, distillation provenance propagation, untrusted-inbound gate)
- **Channels + Interaction Resolver** (approval IS authorization, single-use tokens,
  per-effect assurance)
- **Observability** (verification + counterfactual replay, cost reconciliation)

Demos (all pass): `demo:ledger`, `demo:resume`, `demo:e2e`, `demo:compile`.

Real model adapter: **DONE** — `src/adapters/anthropic-model.ts` (built-in fetch, no
SDK dependency). A live call (`npm run demo:live`) had a real model propose a
3-node workflow that the compiler signed within authority and the engine ran off a
verified ledger. The model is strictly untrusted: its output is validated +
monotonicity-checked, so it can only be rejected, never escalate.

Not yet built: the visible web UI / canvas, and the Postgres (multi-tenant scale)
store adapter. Deeper premortem items remain tracked in `docs/PREMORTEM.md`.
