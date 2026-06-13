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

## UI work — read `docs/DESIGN_SYSTEM.md` first

When building any UI: light & clean (never dark), warm teal palette (see
`web/app/globals.css` for the canonical CSS variables), one 4px spacing scale
(no arbitrary px), one primary action per view, progressive disclosure over
cramming, nothing overlaps. Every screen must pass the checklist in the
design-system doc. Fonts are open-licensed only (Inter/JetBrains Mono via Google
Fonts); never ship another product's font files.

**Canonical design tokens (source of truth: `web/app/globals.css`):**
- Canvas: `#F8F7F4` (warm paper)
- Ink: `#11201F` (warm near-black)
- Brand: `#0E7C75` (teal — primary actions, structure, health)
- Amber `#D97706` — LIVE/ENERGY ONLY: running edges, active-node ring, ticking
  cost, running badge. Never a default button colour.
- OK: `#16794C` (success states)
- Danger: `#B91C1C` (error states)
- Spacing: `--s1` (4px) through `--s9` (64px)

Use `var(--brand)`, `var(--ink)`, etc. in components — never hardcode hex.

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
  plugins/           # think, recall, http-get, email-send, telegram-send, etc.
  extensions/        # YAML capability loader
  mcp/               # MCP client (JSON-RPC 2.0, stdio + HTTP/SSE)
src/adapters/        # I/O adapters OUTSIDE the core (Anthropic, OpenAI, Ollama)
src/infrastructure/  # concrete persistence (SQLite plugin repo)
src/api/             # HTTP server, GenesisRuntime wiring, scheduler
src/demo/            # runnable end-to-end demos
web/                 # Next.js 15 frontend (port 3100)
  app/               # pages: / (builder), agents/[id], runs/, canvas/[agentId],
                     #        capabilities/, approvals/, mcp/, schedules/
  components/        # RunView (reusable run detail viewer)
  lib/               # api.ts (typed client), layout.ts, ledger.ts
capabilities/        # example YAML + JS plugin files
docs/                # ARCHITECTURE, LEDGER_SPEC, PREMORTEM, DESIGN_SYSTEM,
                     # FEATURE_INVENTORY, WORKFLOW, EXTENSION_MODEL
```

## Status (keep this honest, update as you build)

**Built & verified (82 tests pass, typecheck clean):**
- Core: ledger (all 8 invariants), SQLite durable store, identity/secrets/time
- Core: capability plane, manifest + expr evaluator, kernel + engine
- Core: NL→manifest compiler (with capability monotonicity), memory (4 planes)
- Core: channels + interaction resolver, observability + counterfactual replay
- Core: built-in plugins (think, recall, remember, identify, http-get, http-post,
  web-search, email-send, telegram-send, slack-send, notify-webhook, llm-route,
  compose)
- Core: YAML capability loader, TypeScript plugin loader
- Core: MCP client (JSON-RPC 2.0 over stdio/HTTP)
- Core: plugin lifecycle (install/enable/disable/uninstall, supervisor snapshot)
- Adapters: Anthropic, OpenAI, Ollama model ports; semantic distiller
- API: full REST server (agents, runs, capabilities, approvals, schedules, MCP)
- API: cron + interval scheduler (survives restart)
- Web UI: home / agent builder, agent detail (graph + runs + schedules + memory),
  run detail (timeline + canvas + cost + explain + counterfactual), runs list,
  interactive canvas (pan/zoom/scrubber), capabilities catalog, approvals,
  MCP management, schedules

**Not yet built:**
- PostgreSQL multi-tenant store adapter
- Real-time SSE push to the canvas UI (currently polls)
- Inbound Telegram/Slack channel handling (send-only today)
- Visual drag-to-build graph editor (canvas shows graphs; does not yet support
  adding/removing nodes by dragging)
