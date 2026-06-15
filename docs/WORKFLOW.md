# Krelvan — Developer Workflow

How to run, build, and develop in this repository.

---

## Prerequisites

- Node 20+
- `npm install` at repo root
- `npm install` inside `web/` for the frontend

## Environment

Copy `.env.example` (if present) or create `.env` at the root:

```
KRELVAN_ANTHROPIC_KEY=sk-ant-...        # required for demo:live and the API
KRELVAN_LLM_PROVIDER=anthropic          # anthropic | openai | ollama
KRELVAN_LLM_MODEL=claude-sonnet-4-5    # or gpt-4o or qwen2.5:14b
KRELVAN_DATA_DIR=./data                 # where ledger.db, agents.json, etc. live
```

Copy `web/.env.local.example` or create `web/.env.local`:

```
NEXT_PUBLIC_API_URL=http://localhost:3201
```

---

## Daily commands

```bash
# From repo root
npm run typecheck          # strict TypeScript — must be clean before any commit
npm test                   # tests must be green (167/170)

# Start the API server (port 3201)
npm run start:api          # or: node --loader ts-node/esm src/api/index.ts

# Start the web UI (port 3100)
cd web && npm run dev

# Run demos (no web UI needed)
npm run demo:ledger        # views fold from one verified log
npm run demo:resume        # crash + resume, each irreversible effect runs exactly once
npm run demo:e2e           # real multi-agent pipeline off the ledger
npm run demo:compile       # intent → compiled+signed manifest → run
npm run demo:live          # needs KRELVAN_ANTHROPIC_KEY — real model proposes a workflow
```

---

## How a feature gets built

```
spec → failure modes → code → tests → run demo → update PREMORTEM.md
```

1. Add failure modes to `docs/PREMORTEM.md` (mark OPEN)
2. Write the code
3. Write tests in `*.test.ts` next to the implementation
4. Run `npm test` — must be green
5. Run a demo if applicable
6. Mark premortem items GUARDED (with test name) or explicitly WAIVED
7. Only then say it's "done"

Never mark something GUARDED without a passing test that covers it.

---

## Project layout

```
genesis-new/
├── src/
│   ├── core/            # pure, zero-dep core — the trust boundary
│   │   ├── ledger/      # event, canonical, crypto, store, sqlite-store
│   │   ├── manifest/    # manifest schema + typed expr evaluator
│   │   ├── capability/  # admission, budgets, supervisor
│   │   ├── kernel/      # kernel.ts (pure), engine.ts (impure), project.ts
│   │   ├── compiler/    # NL → manifest (model port + monotonicity check)
│   │   ├── memory/      # 4 planes: working, episodic, semantic, soul
│   │   ├── channels/    # stateless adapters + interaction resolver
│   │   ├── identity/    # key lifecycle, monotonic clock
│   │   ├── observability/ # canvas/cost/timeline views, counterfactual replay
│   │   ├── plugins/     # think, recall, http-get, email-send, etc.
│   │   ├── extensions/  # YAML capability loader
│   │   └── mcp/         # MCP client (JSON-RPC 2.0 over stdio/HTTP)
│   ├── adapters/        # I/O adapters outside the core (Anthropic, OpenAI, Ollama)
│   ├── infrastructure/  # concrete persistence (SQLite plugin repo)
│   ├── api/             # HTTP server, KrelvanRuntime wiring, scheduler
│   └── demo/            # runnable end-to-end demos
├── web/                 # Next.js 15 frontend (port 3100)
│   ├── app/             # pages: /, agents/[id], runs/, canvas/[agentId], etc.
│   ├── components/      # RunView (reusable run detail viewer)
│   └── lib/             # api.ts (typed client), layout.ts, ledger.ts
├── capabilities/        # example YAML + JS plugins
├── data/                # runtime data (ledger.db, agents.json, etc.)
└── docs/                # ARCHITECTURE, LEDGER_SPEC, PREMORTEM, DESIGN_SYSTEM, etc.
```

---

## Architecture invariants — do not violate

| Rule | Where enforced |
|------|---------------|
| `decide()` and all projections are pure (no I/O, no clock, no randomness) | `kernel.ts`, `project.ts` |
| Never call `Date.now()` / `new Date()` / `Math.random()` in `src/core/` | Clock is injected |
| No `eval` — conditional logic is the typed AST in `expr.ts` | `expr.ts` |
| No floats in the ledger — money is integer cents | `canonical.ts` |
| Plugins never self-sign — supervisor co-signs observed results | `capability.ts` |
| Secrets never reach plugins — broker mints scoped tokens | `ports.ts` |
| Deny-by-default — capability not in manifest node → denied | `capability.ts` |
| Non-owner principal cannot widen capability grants | `compiler.ts` |
| Zero third-party runtime deps in `src/core/` | `package.json` |

---

## Adding a new built-in plugin

1. Create `src/core/plugins/<name>.ts`
2. Export a `CapabilityPlugin` object:
   ```typescript
   export const myPlugin: CapabilityPlugin = {
     name: "my_plugin",
     sideEffect: "read",           // be conservative
     estimateCents: (_call) => 2,  // integer only
     async invoke(call) {
       // do work
       return { output: { ... }, claimedCostCents: 2 };
     },
   };
   ```
3. Register it in `src/api/runtime.ts` in the built-ins list
4. Add it to `web/lib/api.ts` capability name type if needed
5. Write tests

---

## Adding a YAML capability (user-facing)

Place a `.yaml` file in `capabilities/` or POST it to `POST /api/capabilities`:

```yaml
name: my-webhook
description: Call my service
sideEffect: write-reversible
estimateCents: 3
http:
  url: "https://api.example.com/{{input.endpoint}}"
  method: POST
  headers:
    Authorization: "Bearer {{secret:MY_API_KEY}}"
  body:
    event: "{{input.event}}"
input:
  endpoint: string
  event: string
output:
  ok: boolean
```

---

## UI development

```bash
cd web
npm run dev          # hot reload at localhost:3100
npm run typecheck    # strict TS — must be clean
```

Design tokens are in `web/app/globals.css`. Use CSS variables (`--brand`, `--ink`, `--canvas`, etc.) — no hardcoded hex in components. See `docs/DESIGN_SYSTEM.md` for full palette and rules.

Current palette:
- Canvas: `#F8F7F4` (warm paper)
- Brand: `#0E7C75` (teal — primary actions, structure)
- Amber `#D97706` — LIVE/ENERGY ONLY (running state, never a default button)
- Ink: `#11201F` (warm near-black)

---

## Debugging a run

1. Start a run via the UI home page or `POST /api/runs`
2. Watch the SSE stream: `GET /api/runs/:id/stream`
3. Inspect raw events: `GET /api/runs/:id/events`
4. Ask for an explanation: `GET /api/runs/:id/explain`
5. Use the canvas page (`/canvas/:agentId`) to scrub through events step by step (← → keys)

If a run halts:
- Check `GET /api/runs/:id` for `projection.openAwaits` — a non-empty set means a HITL approval is pending
- Check `GET /api/approvals` — approve or deny from there or the UI

---

## Testing approach

- Tests live next to the code they test (`foo.ts` → `foo.test.ts`)
- Use `node:test` (built-in, no Jest)
- In-memory adapters for ledger (no SQLite needed in unit tests)
- No mocking of core logic — use real in-memory implementations
- A subsystem is "done" only when its premortem items are GUARDED with test names
