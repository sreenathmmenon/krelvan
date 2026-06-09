# AGENTS.md — Genesis (core)

*Instructions for any AI agent (or human) working in this repository. Read this
before writing code. These rules are not suggestions — they encode the architecture
and the quality bar this project is built to.*

---

## What this project is

Genesis: a self-hostable platform where a person, a team, or an enterprise can own,
run, and **trust** their own AI agents. Built ground-up in TypeScript to the target
architecture in `../genesis/docs/` (ARCHITECT_FUTURE_PLAN, TARGET_ARCHITECTURE,
INTERNAL_ARCHITECTURE). Self-host first; hosted later on the same core, no fork.

**The one principle: the ledger IS the runtime.** Execution is a projection of an
append-only, content-addressed, signed event log. The canvas, cost meter, audit
timeline, and memory are all pure *reads* (folds) of that one log.

---

## Hard rules (do not violate)

1. **Never bluff.** Only claim something works after you have run it and seen the
   output. "Done"/"works"/"passes" requires real evidence (test output, a demo run).
   If you didn't run it, say so. Mark premortem items GUARDED only when a passing
   test covers them.
2. **No `eval`, ever.** Conditional logic is the typed AST evaluator in
   `src/core/manifest/expr.ts`. The model/compiler never executes generated code —
   model output is pure DATA, validated then run, never `eval`'d.
3. **The kernel is pure; the engine is the only impure code.** `decide()` and all
   projections take (manifest, ledger) → result with no I/O, no clock, no randomness.
   Side effects (network, disk, model calls) live only in the engine/adapters.
4. **No raw clock or randomness in the core.** Never call `Date.now()`,
   `new Date()`, or `Math.random()` in `src/core/`. Time is injected (a monotonic
   clock); tests use a logical clock. This keeps replay deterministic.
5. **No floats in the ledger.** Money is integer minor-units (cents). Canonicalize
   rejects non-integer numbers — keep it that way (cross-host hash stability).
6. **Plugins are untrusted.** The supervisor co-signs what it mechanically observed;
   a plugin never self-signs facts about its own behavior. Secrets never touch
   plugins (the broker mints scoped tokens).
7. **Deny-by-default + budget-before-spend.** An ungranted capability, or one over
   budget, never runs. Untrusted-origin intents can never widen grants (capability
   monotonicity).
8. **Zero third-party runtime dependencies in the core.** Use Node built-ins
   (`node:crypto`, `node:sqlite`, `fetch`). This keeps the self-host artifact small
   and license-clean. A new dep needs an explicit reason and a permissive license
   (MIT/Apache/BSD/OFL) — never GPL/AGPL/SSPL/BUSL in the shipped artifact.
9. **No IP theft.** Build from first principles and public primitives. Do not copy
   code from restrictively-licensed projects, transcribe patented algorithms, or
   ship another product's proprietary assets (fonts, logos, closed specs). When a
   genuinely novel technique seems needed, flag it for the owner to clear.
10. **The word "WordPress" must not appear** anywhere in code, docs, or comments.
11. **Git authorship:** commits are authored solely as
    `sreenathmmenon <sreenathmmmenon@gmail.com>` (note: the EMAIL has THREE m's —
    `sreenathmmmenon`; the GitHub username has two). The repo's `git config` is the
    source of truth — prefer a plain `git commit` over `--author`. Never add
    Co-Authored-By or any AI attribution. **Do not commit or push without the owner
    explicitly asking.**

---

## How to work

- **Build bottom-up; prove each layer before the next.** A subsystem is "done" only
  when its premortem section is GUARDED or explicitly WAIVED.
- **Spec → failure modes → code → tests → run.** For load-bearing pieces, write the
  spec and the failure modes first (see `docs/LEDGER_SPEC.md`, `docs/PREMORTEM.md`).
- **Typed errors, no silent failures.** Expected conditions return a `Result<T>`;
  throw only for genuine programmer errors. A verification failure is LOUD (the run
  is marked UNVERIFIABLE), never "confident but wrong".
- **Strict TypeScript.** `npm run typecheck` must be clean (strict,
  `noUncheckedIndexedAccess`). Fix the type, don't cast it away.

## Commands

```
npm install
npm run typecheck     # strict TS — must be clean
npm test              # node:test suite — must be green before claiming done
npm run demo:ledger   # the inversion (views fold from one verified log)
npm run demo:resume   # crash + resume, each irreversible effect runs exactly once
npm run demo:e2e      # a real multi-agent run drives itself off the ledger
npm run demo:compile  # intent -> compiled+signed manifest -> run
npm run demo:live     # (needs GENESIS_ANTHROPIC_KEY) a REAL model proposes a workflow
```

## Layout

```
src/core/            # the pure, dependency-free core
  ledger/            # events, canonical, crypto, store (in-mem + sqlite), verify
  manifest/          # manifest + the typed expr evaluator (no eval)
  capability/        # admission, budgets, supervisor co-signing
  kernel/            # pure decide() + project() + the impure engine
  identity/          # keys (rotate/revoke), secret broker, monotonic clock
  memory/            # 4 planes, distillation provenance, untrusted-inbound gate
  channels/          # stateless adapters + the trusted interaction resolver
  observability/     # verification + counterfactual replay, cost views
src/adapters/        # I/O adapters OUTSIDE the core (e.g. anthropic-model)
src/demo/            # runnable end-to-end demos
docs/                # LEDGER_SPEC, PREMORTEM, DESIGN_SYSTEM
```

## UI work — read `docs/DESIGN_SYSTEM.md` first

When building any UI: light & clean (never dark), sarvam-calibrated palette
(near-white canvas `#FAFAFA`, indigo-navy ink `#1E2033`, green accent), one 4px
spacing scale (no arbitrary px), one primary action per view, progressive
disclosure over cramming, nothing overlaps. Every screen must pass the checklist in
the design-system doc. Fonts are open-licensed only (Inter/JetBrains Mono); never
ship another product's font files.

## Status (keep this honest, update as you build)

Built & verified (82 tests pass, typecheck clean): ledger, SQLite durable store,
identity/secrets/time, capability plane, manifest+expr, kernel+engine, NL→manifest
compiler, memory, channels, observability, and a real Anthropic model adapter.
Not yet built: the web UI/canvas, and a Postgres (multi-tenant scale) store adapter.
