# Genesis — Instructions for Claude Code

This is `genesis-new`, the active TypeScript codebase. Read `AGENTS.md` first for
all hard rules. This file adds Claude-specific guidance.

---

## This project (NOT the old Python repo)

- **Active codebase:** `/Users/sreenath/Code/myAIExps/genesis-new` ← you are here
- **Old PoC (ignore):** `/Users/sreenath/Code/myAIExps/genesis` (Python/FastAPI/LangGraph)
- API runs on port **3201**. Web UI runs on port **3100**.

---

## Stack

- **Core:** Pure TypeScript, Node 20+, zero third-party runtime deps in `src/core/`
- **API:** Node `http` module (no Express/Fastify)
- **Web:** Next.js 15, React 19, TypeScript strict mode
- **DB:** SQLite via `node:sqlite` (built-in, no ORM)
- **LLM:** Anthropic Claude (primary), OpenAI, Ollama — all via raw `fetch`
- **Tests:** `node:test` (built-in, no Jest)

---

## The one principle

**The ledger IS the runtime.** Every view (canvas, cost meter, timeline, memory)
is a pure fold of the append-only, SHA-256 content-addressed, HMAC-signed event
log. If you want to know what an agent did, fold the ledger. The UI cannot lie
about execution because it has no independent state.

---

## Hard rules (from AGENTS.md — abridged here for quick reference)

1. Never bluff. Only say something works after running it and seeing the output.
2. No `eval`, ever. Conditional logic is the typed AST in `src/core/manifest/expr.ts`.
3. Kernel is pure. `decide()` and projections: no I/O, no clock, no randomness.
4. No `Date.now()` / `new Date()` / `Math.random()` in `src/core/`. Time is injected.
5. No floats in the ledger. Money is integer cents.
6. Plugins are untrusted. Supervisor co-signs. Secrets never touch plugins.
7. Deny-by-default. Non-owner principal cannot widen capability grants.
8. Zero third-party runtime deps in `src/core/`.
9. The word "W***P***s" (you know which one) must not appear anywhere.
10. **Git:** commits authored solely as `sreenathmmenon <sreenathmmmenon@gmail.com>`.
    No Co-Authored-By. No AI attribution. Do not commit without owner asking.

---

## Commands

```bash
npm run typecheck     # must be clean — fix the type, never cast
npm test              # 82 tests, all must pass
npm run demo:ledger   # ledger inversion demo
npm run demo:resume   # crash + resume demo
npm run demo:e2e      # full 3-agent pipeline
npm run demo:compile  # NL → manifest → run
npm run demo:live     # needs GENESIS_ANTHROPIC_KEY
cd web && npm run dev # web UI at localhost:3100
```

---

## Key files to know

| File | What it does |
|------|-------------|
| `src/core/kernel/kernel.ts` | Pure `decide()` — the heart of the system |
| `src/core/kernel/engine.ts` | The only impure code — carries out decisions |
| `src/core/kernel/project.ts` | `project(events) → RunProjection` — pure fold |
| `src/core/ledger/store.ts` | LedgerStore port + in-memory adapter |
| `src/core/ledger/sqlite-store.ts` | Durable SQLite adapter |
| `src/core/compiler/compiler.ts` | NL → signed manifest (with monotonicity check) |
| `src/core/capability/capability.ts` | Admission + budget + supervisor co-signing |
| `src/core/manifest/expr.ts` | Typed AST evaluator (the safe alternative to eval) |
| `src/api/runtime.ts` | GenesisRuntime — wires everything together |
| `src/api/server.ts` | REST API routes |
| `web/app/page.tsx` | Home page — the NL agent builder UI |
| `web/app/canvas/[agentId]/page.tsx` | Interactive canvas (pan/zoom/scrubber) |
| `web/lib/api.ts` | Typed API client |
| `web/lib/layout.ts` | Graph layout (single source of truth — use this, not local copies) |
| `web/app/globals.css` | Design tokens — use CSS vars, never hardcode hex |

---

## What is built vs not built

**Built (82 tests, typecheck clean):**
Full core (ledger, kernel, compiler, memory, channels, observability), all
built-in plugins (think/recall/http-get/email-send/telegram-send/etc.), plugin
lifecycle, MCP client, full REST API, scheduler, and the complete web UI (home
builder, agent detail, run detail, interactive canvas, capabilities, approvals,
MCP, schedules).

**Not yet built:**
- PostgreSQL multi-tenant store adapter
- Real-time SSE push to canvas UI (polls today)
- Inbound Telegram/Slack (send-only today)
- Drag-to-build visual graph editor

See `docs/FEATURE_INVENTORY.md` for the full accurate list.

---

## Design system

Tokens are in `web/app/globals.css`. Always use CSS variables:

```css
--canvas: #F8F7F4      /* warm paper background */
--brand:  #0E7C75      /* teal — primary actions */
--live:   #D97706      /* amber — RUNNING STATE ONLY, never a button */
--ink:    #11201F      /* warm near-black */
--ok:     #16794C      /* success */
--danger: #B91C1C      /* error */
```

One 4px grid: `--s1` (4px) … `--s9` (64px). No arbitrary pixel values.

---

## Comparison with other platforms

Genesis is an **agent orchestration platform**, not an automation tool. Compare it
to LangGraph, Mastra, or Temporal — not to pre-agentic trigger/action tools.

What makes Genesis distinct:
- **Ledger as runtime:** execution IS the log; no separate state store
- **Capability monotonicity:** LLM cannot escalate privileges beyond what the
  manifest grants — prompt injection cannot widen permissions
- **Evidentiary canvas:** the UI is a fold of the ledger; it cannot misrepresent
  what executed
- **NL → signed manifest:** natural language compiles to a cryptographically signed
  program, not a dynamic prompt chain
- **Crash-hole safety:** the kernel halts on any unresolved effect; it never
  silently skips a side effect
- **Sub-agent composition:** a capability can be backed by a full sub-run with
  delegated budget (reserve-then-settle)
- **HITL with assurance levels:** approvals are branch-scoped, single-use, and
  gated on assurance requirements per effect class
