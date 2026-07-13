# Krelvan — Complete Feature Inventory

*Ground truth derived from reading every source file. No assumptions.*

---

## Core Architecture

### The Ledger Runtime (`src/core/ledger/`)

| Feature | File | Status |
|---------|------|--------|
| Append-only SHA-256 content-addressed event log | `event.ts` | Built |
| Hash-chained events (each event's id covers prevHash + offset + scope + ts) | `event.ts` | Built |
| Deterministic canonical JSON (no floats, sorted keys, no IEEE-754) | `canonical.ts` | Built |
| HMAC-SHA256 signing with time-windowed keys | `crypto.ts` | Built |
| HmacKeyring: key rotation, revocation, validity windows | `crypto.ts` | Built |
| In-memory ledger store (test adapter, per-tenant async mutex) | `store.ts` | Built |
| SQLite durable store (`node:sqlite`, WAL + FULL fsync, crash-safe) | `sqlite-store.ts` | Built |
| Ledger integrity verification (hash, chain, offsets, signatures) | `store.ts` | Built |
| Optimistic concurrency control (CAS append, no forks) | `store.ts` | Built |
| Tail truncation detection via signed checkpoint | `store.ts` | Built |
| Typed error model (`Result<T>`, 11 error kinds) | `errors.ts` | Built |
| Safe payload extractors for untrusted event data | `payload.ts` | Built |

### Manifest (Declarative Program) (`src/core/manifest/`)

| Feature | File | Status |
|---------|------|--------|
| Manifest schema (nodes, edges, entry, budgets, seed, intent) | `manifest.ts` | Built |
| Node capabilities with per-capability budget ceilings | `manifest.ts` | Built |
| Autonomy levels: suggest / act-with-veto / full | `manifest.ts` | Built |
| Six side-effect classes (read → identity-mutation) | `manifest.ts` | Built |
| Sub-agent bindings (manifest-backed capability) | `manifest.ts` | Built |
| Seed field (static initial state embedded in manifest) | `manifest.ts` | Built |
| Structural manifest validation (dangling edges, bad entry, etc.) | `manifest.ts` | Built |
| Safe typed AST expression evaluator (no eval) | `expr.ts` | Built |
| Conditional edge routing (`when: Expr`) | `expr.ts` | Built |
| Depth-bounded (max 32 levels), non-Turing-complete | `expr.ts` | Built |
| Strict undeclared-key rejection in expressions | `expr.ts` | Built |

### Capability Plane (`src/core/capability/`)

| Feature | File | Status |
|---------|------|--------|
| Deny-by-default admission (unlisted capability = denied) | `capability.ts` | Built |
| Budget enforcement pre-dispatch (reserve → settle) | `capability.ts` | Built |
| Per-capability hard budget ceiling | `capability.ts` | Built |
| Run-level budget ceiling | `capability.ts` | Built |
| Autonomy-gated approval (suggest always asks, full never asks) | `capability.ts` | Built |
| Deterministic idempotency keys (SHA-256 of nodeId + capability + input hash) | `capability.ts` | Built |
| Supervisor co-signs effect results (plugin never self-signs) | `capability.ts` | Built |
| Directory-based capability loading (YAML + JS/TS) | `directory-loader.ts` | Built |

### Kernel & Engine (`src/core/kernel/`)

| Feature | File | Status |
|---------|------|--------|
| Pure kernel: `decide(manifest, projection) → Decision` (zero I/O) | `kernel.ts` | Built |
| Crash-hole safety (unresolved EffectRequested → HALT, never skip) | `kernel.ts` | Built |
| Open-await check (parked approval → HALT) | `kernel.ts` | Built |
| Loop-bound enforcement (maxNodeVisits → FAIL) | `kernel.ts` | Built |
| Conditional edge selection via typed AST evaluator | `kernel.ts` | Built |
| Thin impure engine (executes kernel decisions, appends events) | `engine.ts` | Built |
| 3-event effect protocol: AdmissionDecision → EffectRequested → EffectResult | `engine.ts` | Built |
| Crash-safe resume: re-fold ledger, continue from last decision | `engine.ts` | Built |
| Each capability in a node sees outputs from prior capabilities | `engine.ts` | Built |
| Sub-agent execution (spawn full sub-run, budget delegated) | `engine.ts` + `sub-agent-executor.ts` | Built |
| Pure ledger projection `project(events) → RunProjection` | `project.ts` | Built |
| Crash-hole detection on projection | `project.ts` | Built |
| Budget tracking (spent + reserved) in projection | `project.ts` | Built |
| Incremental fold (apply only new events on checkpoint) | `incremental-fold.ts` | Built |

### NL → Manifest Compiler (`src/core/compiler/`)

| Feature | File | Status |
|---------|------|--------|
| Model port interface (untrusted — proposes data only) | `compiler.ts` | Built |
| Structural validation after model proposal | `compiler.ts` | Built |
| Capability monotonicity enforcement (non-owner cannot widen grants) | `compiler.ts` | Built |
| Principal kinds: owner / channel / agent / memory | `compiler.ts` | Built |
| Self-correction loop (up to 3 attempts if validation fails) | `compiler.ts` + API | Built |
| Signed manifest with provenance (intent, principal, compiledAt) | `compiler.ts` | Built |
| Content-addressed manifest ID | `compiler.ts` | Built |

### Memory (`src/core/memory/`)

| Feature | File | Status |
|---------|------|--------|
| Four memory planes: working, episodic, semantic, soul | `memory.ts` | Built |
| Episodic memory (per-run summaries) | `memory.ts` | Built |
| Semantic memory (distilled facts with provenance) | `memory.ts` | Built |
| Soul (agent identity: name, values, standing instructions; versioned) | `memory.ts` | Built |
| Untrusted-inbound gate (channel/agent provenance cannot influence spend/write-irreversible/identity-mutation) | `memory.ts` | Built |
| Distillation provenance (which model, which episodes distilled from) | `memory.ts` | Built |
| All memory stored in ledger (no separate database) | `memory.ts` | Built |
| Semantic distiller via Anthropic adapter | `anthropic-distiller.ts` | Built |

### Channels & HITL (`src/core/channels/`)

| Feature | File | Status |
|---------|------|--------|
| Stateless channel adapters (Telegram, Slack) | `channel.ts` | Built |
| Trusted interaction resolver (separate from adapters) | `channel.ts` | Built |
| Single-use approval tokens (replay-proof) | `channel.ts` | Built |
| Branch-scoped tokens (approval cannot migrate across runs) | `channel.ts` | Built |
| Assurance-gated approval (effect class → required assurance level) | `channel.ts` | Built |
| Pending approvals API + UI | API + `web/app/approvals/` | Built |

### Identity & Time (`src/core/identity/`)

| Feature | File | Status |
|---------|------|--------|
| Key lifecycle: issue, rotate, revoke | `identity.ts` | Built |
| Time-windowed keys (old signatures still verify after rotation) | `identity.ts` | Built |
| Monotonic logical clock (never goes backward, replay deterministic) | `clock.ts` | Built |

### Observability (`src/core/observability/`)

| Feature | File | Status |
|---------|------|--------|
| Canvas view (node states folded from ledger) | `observe.ts` | Built |
| Cost view (spent + reserved by effect) | `observe.ts` | Built |
| Timeline view (offset, scope, type, author per event) | `observe.ts` | Built |
| Ledger integrity verification (full recompute) | `observe.ts` | Built |
| Counterfactual replay (fork at node, re-gate downstream effects) | `observe.ts` | Built |
| Structured tracing (Tracer interface + NoopTracer) | `spans.ts` | Built |
| Structured logging | `logger.ts` | Built |

---

## Built-in Capabilities (Plugins)

| Capability | Side Effect | Notes |
|-----------|-------------|-------|
| `think` | read | LLM reasoning; structured output with domain keys spread into run state |
| `recall` | read | Reads agent semantic memory |
| `remember` | write-irreversible | Writes episode summary to episodic memory |
| `identify` | read | Reads agent soul (identity) |
| `llm_route` | read | LLM picks the next node |
| `http_get` | read | Real HTTP GET with SSRF guard (blocks private/loopback IPs) |
| `http_post` | write-reversible | Real HTTP POST |
| `web_search` | read | Google/Brave web search |
| `compose` | write-reversible | Sequential capability composition |
| `email_send` | message-human | SMTP email |
| `telegram_send` | message-human | Telegram API |
| `slack_send` | message-human | Slack API |
| `notify_webhook` | write-reversible | Webhook notification |

---

## Plugin System (`src/core/plugins/`)

| Feature | File | Status |
|---------|------|--------|
| Plugin kinds: builtin, YAML, TypeScript, MCP | `types.ts` | Built |
| YAML capability loader (HTTP-mapped, template interpolation, no eval) | `yaml-capability.ts` | Built |
| TypeScript/JS plugin loader | `typescript-plugin-loader.ts` | Built |
| Plugin install / enable / disable / uninstall lifecycle | `lifecycle-service.ts` | Built |
| Source hash verification at load (SOURCE_CHANGED detection) | `lifecycle-service.ts` | Built |
| Secret refs (`{{secret:name}}`) — broker mints scoped tokens | `ports.ts` | Built |
| Plugin metadata persisted in SQLite | `sqlite-plugin-repository.ts` | Built |
| Atomic supervisor snapshot swap (enable/disable is instantaneous) | `plugin-activator.ts` | Built |
| Plugin lifecycle events written to ledger | `plugin-ledger-writer.ts` | Built |

---

## MCP Integration (`src/core/mcp/`)

| Feature | File | Status |
|---------|------|--------|
| JSON-RPC 2.0 over stdio (local MCP servers) | `mcp-client.ts` | Built |
| HTTP/SSE transport (remote MCP servers) | `mcp-client.ts` | Built |
| Auto-discovery: MCP tools become CapabilityPlugins automatically | `mcp-client.ts` | Built |
| MCP tools always supervised (never self-sign) | `mcp-client.ts` | Built |
| MCP management API (connect/disconnect/list) | `server.ts` | Built |
| MCP management UI | `web/app/mcp/page.tsx` | Built |

---

## API Server (`src/api/`)

### Agent Routes
| Route | Description |
|-------|-------------|
| `GET /api/agents` | List all agents with manifest + status |
| `POST /api/agents` | Compile intent → save manifest (direct) |
| `POST /api/agents/build` | Full builder loop (propose → validate → self-correct up to 3×) |
| `GET /api/agents/:id` | Single agent detail |
| `DELETE /api/agents/:id` | Delete agent (blocked if active run) |
| `GET /api/agents/:id/runs` | All runs for agent |
| `GET /api/agents/:id/memory` | Agent memory (episodic + semantic + soul) |
| `DELETE /api/agents/:id/memory` | Clear agent memory |

### Run Routes
| Route | Description |
|-------|-------------|
| `GET /api/runs` | All runs |
| `POST /api/runs` | Start a run |
| `GET /api/runs/:id` | Run summary + projection |
| `GET /api/runs/:id/stream` | SSE stream of ledger events (real-time) |
| `GET /api/runs/:id/events` | Raw ledger events |
| `GET /api/runs/:id/explain` | LLM explanation of what happened |

### Capability Routes
| Route | Description |
|-------|-------------|
| `GET /api/capabilities` | List all plugins |
| `POST /api/capabilities` | Install new plugin (YAML or JS/TS) |
| `PATCH /api/capabilities/:name` | Enable or disable |
| `DELETE /api/capabilities/:name` | Uninstall |

### Other Routes
| Route | Description |
|-------|-------------|
| `GET /api/approvals` | Pending HITL approvals |
| `POST /api/approvals/:id/resolve` | Approve or deny |
| `GET /api/schedules` | List schedules |
| `POST /api/schedules` | Create schedule (cron or interval) |
| `PATCH /api/schedules/:id` | Enable or disable schedule |
| `DELETE /api/schedules/:id` | Delete schedule |
| `GET /api/mcp` | List MCP servers |
| `POST /api/mcp` | Connect MCP server |
| `DELETE /api/mcp/:name` | Disconnect MCP server |
| `GET /api/health` | Liveness probe |

---

## Scheduler (`src/api/scheduler.ts`)

| Feature | Status |
|---------|--------|
| Cron schedule (5-field: min hour day month weekday) | Built |
| Interval schedule (milliseconds) | Built |
| Enable / disable per schedule | Built |
| Persists in `data/schedules.json` (survives restart) | Built |
| Re-arms active schedules on startup | Built |
| Last run time + next run time tracking | Built |
| Zero third-party deps (Node setInterval/setTimeout only) | Built |

---

## Web UI (`web/`)

### Home / Agent Builder (`web/app/page.tsx`)

| Feature | Status |
|---------|--------|
| Intent composer textarea with placeholder | Built |
| Example prompt chips (one-click population) | Built |
| Build stages animation ("Proposing graph… → Validating… → Finalising agent…") | Built |
| Self-correction indicator ("Succeeded on attempt N of 3") | Built |
| BuildPreviewModal: compiled graph preview before running | Built |
| BuildPreviewModal: node list with capability pills | Built |
| BuildPreviewModal: budget display | Built |
| FullMiniGraph SVG preview in modal | Built |
| "Run now" or "Discard" from preview | Built |
| Agent card grid with MiniGraph visualization | Built |
| Agent card: last run cost, status badge | Built |
| Agent card: Run button (immediate start) | Built |
| Agent card: Delete with 2-step confirmation | Built |
| Stats strip: agents / running now / total runs / total spent | Built |
| Recent runs sidebar | Built |

### Agent Detail (`web/app/agents/[id]/page.tsx`)

| Feature | Status |
|---------|--------|
| Full agent graph canvas (SVG, Sugiyama-lite layout) | Built |
| Node selection + detail panel (role, capabilities) | Built |
| Graph tab / Runs tab / Schedules tab / Memory tab | Built |
| Run now button | Built |
| Delete agent with confirmation | Built |
| Link to full interactive canvas | Built |
| Schedule panel (cron/interval presets, enable/pause/delete) | Built |
| Memory tab (episodic, semantic facts, soul) | Built |

### Interactive Canvas (`web/app/canvas/[agentId]/page.tsx`)

| Feature | Status |
|---------|--------|
| Pan + zoom (mouse drag, scroll wheel, keyboard +/-) | Built |
| "Fit to screen" control | Built |
| Zoom step controls (−/xx%/+/⊡ toolbar) | Built |
| Keyboard scrubber (← → step through events) | Built |
| Node click → detail panel (role, capabilities, autonomy, full run state) | Built |
| Entry node visual marker (triangle) | Built |
| Run selector dropdown (all runs for this agent) | Built |
| Live run status overlaid on nodes (idle/running/done/failed) | Built |
| Event scrubber (timeline replay) | Built |
| Tamper-evident ledger badge (SHA-256/chain/HMAC explained in tooltip) | Built |
| Canvas fade-in on mount | Built |
| Node detail panel: collapsible "Full run state" section | Built |

### Run Detail (`web/app/runs/[id]/page.tsx`)

| Feature | Status |
|---------|--------|
| Full event timeline | Built |
| Node execution canvas (real-time status) | Built |
| Cost breakdown by effect | Built |
| Raw event log viewer | Built |
| Counterfactual "What if" replay UI | Built |
| "Explain" button (LLM explains what happened) | Built |

### Runs List (`web/app/runs/page.tsx`)

| Feature | Status |
|---------|--------|
| Filterable run table (all / running / halted / completed / failed) | Built |
| Status badges + cost per run | Built |
| Copy-to-clipboard run ID | Built |
| Real-time polling (3s refresh) | Built |

### Capabilities Catalog (`web/app/capabilities/page.tsx`)

| Feature | Status |
|---------|--------|
| Builtin plugins listed | Built |
| User-installed plugins listed | Built |
| Install new capability (YAML or JS file) | Built |
| Enable / disable toggle | Built |
| Secret validation | Built |

### Approvals (`web/app/approvals/page.tsx`)

| Feature | Status |
|---------|--------|
| List pending HITL approvals | Built |
| Approve / deny buttons | Built |
| Effect details + assurance level shown | Built |

### MCP (`web/app/mcp/page.tsx`)

| Feature | Status |
|---------|--------|
| List connected MCP servers | Built |
| Connect new server (config form) | Built |
| Disconnect button | Built |

### Schedules (`web/app/schedules/page.tsx`)

| Feature | Status |
|---------|--------|
| List all agent schedules | Built |
| Create new (cron or interval) | Built |
| Enable / disable toggle | Built |
| Next run time + last run displayed | Built |

---

## Adapters

| Adapter | Description | Status |
|---------|-------------|--------|
| Anthropic model (Claude) | NL → manifest proposal via fetch (no SDK) | Built |
| OpenAI model (gpt-4o) | Alternative model port | Built |
| Ollama model | Local model port | Built |
| Anthropic distiller | Semantic memory distillation | Built |
| HTTP retry | Exponential backoff for model API calls | Built |
| Unified LLM client | Abstracts Anthropic/OpenAI/Ollama with token counting | Built |

---

## Demo Scripts

| Script | What it proves |
|--------|---------------|
| `demo:ledger` | Canvas + cost + audit all fold from one verified log |
| `demo:resume` | Kill mid-run, resume; irreversible effects run exactly once |
| `demo:e2e` | 3-agent pipeline drives itself off the ledger |
| `demo:compile` | Intent → signed manifest → run; untrusted principal rejected |
| `demo:live` | Real Anthropic model → compiler → engine → ledger verification |
| `demo:plugins` | Plugin loading + execution |

---

## Test Coverage

**490/490 tests passing** (1 requires Ollama and skips without it) across:
- Ledger invariants (I1-I8), canonicalization, concurrent appends, key rotation
- Manifest validation, expression evaluator
- Kernel decision tree
- Engine execution, crash-hole detection
- Memory projection
- Compiler monotonicity
- Channel resolver, single-use tokens
- Plugin lifecycle
- YAML capability loader
- HTTP retry
- Spans/observability

---

## What Is NOT Yet Built

| Item | Notes |
|------|-------|
| PostgreSQL multi-tenant store adapter | SQLite only today; Postgres adapter designed but not coded |
| Real-time SSE push to UI canvas | Canvas polls today; SSE stream exists on API but UI uses polling |
| Telegram/Slack channel adapters (channel-side) | Send plugins exist; inbound message handling not wired |
| Visual canvas editor (drag-to-build graph) | Canvas page shows graphs; interactive node/edge editing not present |
