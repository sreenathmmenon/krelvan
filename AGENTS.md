# AGENTS.md — Krelvan

*Instructions for any AI agent (or human) working in this repository. Read this
before writing code. These rules are not suggestions — they encode the architecture
and the quality bar this project is built to.*

---

## What this project is

**Krelvan**: a self-hostable platform where a person, a team, or an enterprise can own,
run, and **trust** their own AI agents. You describe an outcome in natural language;
Krelvan builds a real agent, runs it, and keeps a signed, replayable record of every
step. Built ground-up in TypeScript. Self-host first; hosted later on the same core,
no fork.

**The one principle: the ledger IS the runtime.** Execution is a projection of an
append-only, content-addressed, signed event log. The canvas, the audit timeline, run
history, and memory are all pure *reads* (folds) of that one log — so "what you see is
exactly what executed" is structural, not hopeful.

**What makes Krelvan agentic (not a workflow runner):** it builds agents from NL,
reasons about *why* a run failed (failure-reasoning over the signed ledger), and
auto-retries by rebuilding a corrected agent. The trust layer (signed ledger +
six side-effect classes + approval gates) is the moat.

---

## Hard rules (do not violate)

1. **Never bluff.** Only claim something works after you have run it and seen the
   output. "Done"/"works"/"passes" requires real evidence. For UI, that means looking
   at an actual rendered **screenshot** (Playwright) — a clean typecheck/build is NOT
   proof the UI looks right. Mark premortem items GUARDED only when a passing test
   covers them.
2. **No fake/hardcoded data, ever.** Capabilities, marketplace entries, counts, and
   examples must be real and actually work. No fabricated metrics, ratings, or
   non-installing catalog entries. The marketplace registry is a real Git repo
   (`registry/index.json`); every entry must genuinely install.
3. **No cost / price shown to the user, anywhere — UI *and* LLM-generated text.**
   `estimateCents` is a flat budget-reservation guess, never a real price, so it is
   never displayed. (The marketplace free/paid label for a *capability* is the one
   allowed money mention — that's a license price, not a run cost.) When prompting an
   LLM, instruct it not to mention cost/money/budget.
4. **No `eval`, ever.** Conditional logic is the typed AST evaluator in
   `src/core/manifest/expr.ts`. Model/compiler output is pure DATA — validated then
   run, never `eval`'d.
5. **The kernel is pure; the engine is the only impure code.** `decide()` and all
   projections take (manifest, ledger) → result with no I/O, no clock, no randomness.
   Side effects (network, disk, model calls) live only in the engine/adapters.
6. **No raw clock or randomness in the core.** Never call `Date.now()`, `new Date()`,
   or `Math.random()` in `src/core/`. Time is injected (a monotonic clock); tests use
   a logical clock. This keeps replay deterministic.
7. **No floats in the ledger.** Numbers stored in events are integer minor-units;
   canonicalize rejects non-integer numbers (cross-host hash stability). This is a
   backend invariant — it is independent of rule 3 (which is about display).
8. **Plugins are untrusted.** The supervisor co-signs what it mechanically observed; a
   plugin never self-signs facts about its own behavior. Secrets never touch plugins
   (the broker mints scoped tokens).
9. **Deny-by-default + budget-before-spend.** An ungranted capability, or one over
   budget, never runs. Untrusted-origin intents can never widen grants (capability
   monotonicity).
10. **Zero third-party runtime dependencies in the CORE.** Use Node built-ins
    (`node:crypto`, `node:sqlite`, `fetch`). A new dep needs an explicit reason and a
    permissive license (MIT/Apache/BSD/OFL) — never GPL/AGPL/SSPL/BUSL in the shipped
    artifact. (The `web/` Next.js app is a separate package; this rule is about core.)
11. **No IP theft.** Build from first principles and public primitives. Don't copy code
    from restrictively-licensed projects, transcribe patented algorithms, or ship
    another product's proprietary assets (fonts, logos, closed specs).
12. **The word "WordPress" must not appear** anywhere in code, docs, or comments
    (reason about the concept without the word).
13. **Git authorship:** commits are authored solely as
    `sreenathmmenon <sreenathmmmenon@gmail.com>` (the EMAIL has THREE m's —
    `sreenathmmmenon`; the GitHub username has two). Prefer a plain `git commit` over
    `--author`. Never add Co-Authored-By or any AI attribution. **Do not commit or push
    without the owner explicitly asking.**

---

## How to work

- **Build bottom-up; prove each layer before the next.** A subsystem is "done" only
  when its premortem section is GUARDED or explicitly WAIVED.
- **Spec → failure modes → code → tests → run.** For load-bearing pieces, write the
  spec and failure modes first (`docs/LEDGER_SPEC.md`, `docs/PREMORTEM.md`).
- **Typed errors, no silent failures.** Expected conditions return a `Result<T>`; throw
  only for genuine programmer errors. A verification failure is LOUD (the run is marked
  UNVERIFIABLE), never "confident but wrong".
- **Strict TypeScript.** `npm run typecheck` must be clean (strict,
  `noUncheckedIndexedAccess`). Fix the type, don't cast it away.
- **Validate UI by looking.** Drive the real app with Playwright, screenshot it, and
  *look*. Check desktop AND mobile. Production-grade means: no overlap, readable nav,
  good empty/loading/error states, no horizontal overflow, no cost shown.

## Commands

```
npm install
npm run typecheck     # strict TS — must be clean
npm test              # node:test suite — 490/490 (1 test requires Ollama and skips without it)
npm run demo:ledger   # the inversion (views fold from one verified log)
npm run demo:resume   # crash + resume, each irreversible effect runs exactly once
npm run demo:e2e      # a real multi-agent run drives itself off the ledger
npm run demo:compile  # intent -> compiled + signed manifest -> run
npm run demo:live     # (needs an LLM key) a REAL model proposes a workflow
npm run api           # API only (port 3201)
npx krelvan           # boots API + web together (the one-command launcher)
```

**LLM provider config (env, all optional — the UI runs without it):**
`KRELVAN_LLM_PROVIDER` = `anthropic` | `openai` | `gemini` | `groq` | `mistral` |
`ollama` | `compatible` · `KRELVAN_LLM_MODEL` · `KRELVAN_LLM_API_KEY`
(or `KRELVAN_ANTHROPIC_KEY`) · `KRELVAN_LLM_BASE_URL` (required for `compatible`).
NOTE: the committed `.env` may default to `ollama`; if Ollama isn't running, set the
provider/model to a working one (e.g. anthropic + `claude-sonnet-4-6`) before testing
LLM features.

## UI work

Light & clean (never dark, except the landing hero band), warm teal palette. One 4px
spacing scale (no arbitrary px). One primary action per view. Nothing overlaps. Real
empty/loading/error states everywhere (the launch DB is empty — empties must look
inviting, not broken). All numbers in `.mono` (JetBrains Mono, tabular-nums). No emoji
in the product UI — use the teal geometric SVG glyphs. Open-licensed fonts only.

**Canonical design tokens (source of truth: `web/app/globals.css`):**
- Canvas `#F8F7F4` (warm paper) · Ink `#11201F` · Brand `#0E7C75` (teal — primary)
- Amber `#D97706` — **LIVE / ENERGY ONLY** (running edges, active-node ring, running
  badge). Never a default button colour, never a static descriptor.
- OK `#16794C` · Danger `#B91C1C` · Info `#1D4ED8` · Spacing `--s1` (4px) … `--s9` (64px)

Use `var(--brand)`, `var(--ink)`, etc. — never hardcode hex.

## Layout

```
src/core/            # the pure, dependency-free core
  ledger/            # events, canonical, crypto, store (in-mem + sqlite), verify
  manifest/          # manifest + the typed expr evaluator (no eval)
  capability/        # admission, budgets, supervisor co-signing, needsApproval()
  kernel/            # pure decide() + project() + the impure engine
  identity/          # keys (rotate/revoke), secret broker, monotonic clock
  memory/            # planes, distillation provenance, untrusted-inbound gate
  channels/          # stateless adapters + the trusted interaction resolver
  observability/     # verification + counterfactual replay
  plugins/           # think, recall, remember, identify, http-get/post, web-search,
                     #   compose, email/slack/telegram-send, notify-webhook, llm-route, delegate
  extensions/        # YAML capability loader
  mcp/               # MCP client (JSON-RPC 2.0, stdio + HTTP/SSE)
src/adapters/        # I/O adapters OUTSIDE the core
  llm-client.ts      # ONE provider abstraction → anthropic/openai/gemini/groq/
                     #   mistral/ollama/compatible (OpenAI-compatible gateways)
src/infrastructure/  # concrete persistence (SQLite plugin repo)
src/api/             # HTTP server + KrelvanRuntime wiring + scheduler
  server.ts          # routes: agents, runs (+ explain/diagnose/retry), capabilities
                     #   (+ source/PUT), mcp, approvals, schedules
  runtime.ts         # CapabilityRegistry + runtime; getCapabilitySource/updateYaml
src/demo/            # runnable end-to-end demos
web/                 # Next.js 15 frontend (port 3100)
  app/               # / (landing+builder), dashboard, runs, runs/[id],
                     #   agents/[id], canvas/[agentId], capabilities, approvals,
                     #   mcp, schedules
  lib/               # api.ts (typed client), registry.ts (marketplace),
                     #   sideEffects.ts, layout.ts, _builder.tsx (shared builder)
capabilities/        # example YAML + JS plugin files
registry/            # the marketplace registry repo content (index.json + README)
docs/                # LEDGER_SPEC, PREMORTEM, EXTENSION_MODEL, AGENTIC_CAPABILITIES, …
```

## Status (keep this honest, update as you build)

**Built & verified (typecheck clean · 490/490 tests · web build green):**
- Core: ledger (all invariants) + SQLite durable store; identity/secrets/time
- Core: capability plane, manifest + typed-AST expr, pure kernel + engine
- Core: NL→manifest compiler (capability monotonicity), memory planes, channels,
  observability + counterfactual replay
- Core: built-in capabilities (think, recall, remember, identify, http-get/post,
  web-search, compose, email/slack/telegram-send, notify-webhook, llm-route, delegate)
- Core: YAML + TypeScript plugin loaders; MCP client (stdio/HTTP); plugin lifecycle
- Adapters: **7 LLM providers** behind one client (anthropic/openai/gemini/groq/
  mistral/ollama/compatible)
- API: full REST (agents, runs, capabilities, approvals, schedules, MCP) + scheduler;
  **failure-reasoning** (`GET /runs/:id/diagnose`) and **auto-retry-with-fix**
  (`POST /runs/:id/retry`); capability **source view + online YAML edit**
- Web UI: landing + NL builder, dashboard, runs, run detail (timeline + signed graph +
  diagnosis + retry-with-fix), agent detail, interactive canvas (pan/zoom/replay;
  graceful mobile fallback), capabilities marketplace (Installed + Discover tabs,
  side-effect spectrum + live approval simulator, source/edit drawer), MCP, approvals,
  schedules
- Marketplace: Git-registry-backed (`registry/index.json`), free + paid, official +
  community; every entry verified to install
- One-command install (`npx krelvan`) + Docker (`docker compose up`)

**Not yet built:**
- PostgreSQL multi-tenant store adapter
- Asymmetric (ed25519) publisher signing for third-party marketplace trust
- Inbound Telegram/Slack channel handling (send-only today)
- Drag-to-build visual graph editor (canvas shows/replays graphs; no node editing yet)

Deeper open items are tracked in `docs/PREMORTEM.md`.
