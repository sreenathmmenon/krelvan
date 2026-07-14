# Krelvan — Customer Surface Build Plan
### Workstreams: A) Artifacts & Deliverables · B) Agent Front Door · C) Scheduler v2

*Written against the codebase as of July 2026 (434/435 tests green, typecheck clean). Every file path, type, and route named below was verified to exist. This plan is written to be handed to Claude Code and executed workstream by workstream. Read `AGENTS.md` first — every hard rule there applies to every task here.*

---

## Why these three, in this order

The platform's build side (NL builder, canvas, capability plane, marketplace) is ahead of its **consume side**. Today a customer's reward for running an agent is a run-detail page. The three workstreams below build the consume side: outputs become first-class, rendered, shareable objects (A); agents become reachable from outside the admin panel (B); and recurring value becomes reliable and visible (C). A is the foundation — B and C both deliver *artifacts*, so A ships first.

**What already exists and must be reused, not duplicated:**

| Existing piece | Where | Role in this plan |
|---|---|---|
| Inbox page (pull feed over runs, client-side read/archive, output-extraction heuristic) | `web/app/inbox/page.tsx` | Becomes a thin view over the new Artifact store; its `extractOutput()` heuristic moves server-side as the fallback extractor |
| Delivery layer (email/slack/telegram/webhook/discord/sms/whatsapp/x/linkedin) | `src/api/delivery.ts`, wired at `runtime.ts` (~line 1947, `deliverOutput`) | Unchanged transport. Its private extraction logic is replaced by the shared Artifact extractor |
| Webhook trigger tokens (256-bit, hash-only storage, constant-time verify, one per agent) | `src/api/trigger-store.ts`, route `POST /api/triggers/:agentId` | The auth pattern to copy for share links and the public site key |
| Chat runs (`kind: "chat"`, excluded from Inbox/runs list) | `runtime.ts` `RunRecord.kind`, `handleChat` in `server.ts` | Reused as the engine behind the public chat surface |
| Scheduler (5-field cron + interval, `schedules.json`, re-arm on boot) | `src/api/scheduler.ts` | Upgraded in place — no rewrite |
| `remember_map` seed convention (`"last_brief=compose.body"`) | e.g. `templates/research-analyst.manifest.json` | Precedent for the new `output_map` seed convention |

---

# Workstream A — Artifacts & Deliverables

**Goal:** every completed run produces zero or one named, typed, *server-side* Artifact. The Inbox becomes a feed of artifacts. Each artifact has a rendered page and an optional public share link. The run record stays one click behind it ("How this was made").

### A1. The Artifact record and store

New file `src/api/artifact-store.ts`, modeled directly on `RunRegistry` in `runtime.ts` (same `atomicWrite` persistence to `data/artifacts.json`; migrate to the SQLite store later alongside the runs migration — do not block on it).

```ts
export interface ArtifactRecord {
  id: string;                    // "art_" + 12 random base64url chars
  agentId: string;
  agentName: string;
  runId: string;
  scheduleId?: string;           // present when the run was scheduler-fired (see C2)
  title: string;                 // ≤ 120 chars, plain text
  body: string;                  // the full output
  format: "markdown" | "text";   // markdown is the default when the agent declares output
  createdAt: number;
  archived: boolean;             // server-side now (replaces localStorage ARCHIVED_KEY)
  readAt?: number;               // server-side read state (replaces localStorage READ_KEY)
  shareTokenHash?: string;       // sha256 hex of the live share token; absent = private
}
```

Rules (all consistent with existing invariants): integer timestamps only; never store the plaintext share token (hash-only, exactly like `trigger-store.ts`); the store is registered on `KrelvanRuntime` next to `runRegistry`.

### A2. Deterministic output declaration: `output_map`

Heuristic extraction is why the current Inbox needs a 40-line guessing function. Fix it at the source with a seed convention that mirrors `remember_map`:

```json
"seed": {
  "output_map": "title=compose.title,body=compose.body,format=markdown"
}
```

- Parser lives in a new pure module `src/core/manifest/output-map.ts` (core is pure — no I/O, no clock): `parseOutputMap(seed) → { titleKey, bodyKey, format } | null`, with unit tests for malformed strings.
- `validateManifest` gains a non-fatal validation note when `output_map` references a `nodeId.key` whose node doesn't exist (same spirit as edge-key validation).
- **The NL compiler must emit it.** In the compiler prompt assembly (`runtime.ts`, the build path around `handleBuildAgent`), instruct the model: every agent whose final node composes prose MUST set `output_map` in seed. Add a compiler test asserting a built manifest with a compose-style final node carries `output_map`.
- **All shipped templates get `output_map`** (research-analyst, price-monitor, daily-digest, support-agent, inbox-triage, etc.). One template test per file asserts it parses. *Lesson from the last session applies: when you touch a manifest, run its template test — the 9 stale-rig failures came from exactly this class of drift.*

### A3. One extractor, shared everywhere

New `src/api/artifact-extractor.ts`:

```
extractArtifact(manifest, projectionState) → { title, body, format } | null
```

Order: (1) `output_map` if declared and keys resolve to non-empty strings → format as declared; (2) otherwise the exact heuristic currently in `web/app/inbox/page.tsx` `extractOutput()` (suffix priority list → longest-string fallback → notable-values line), ported verbatim with its tests, format `"text"`. Then:

- `runtime.ts` run-completion path (where `deliverOutput` is invoked today, ~1947): after a **non-chat** run completes, call `extractArtifact`; if non-null, `artifactStore.create(...)`, then hand the *same* title/body to `deliverOutput` (delete `deliverOutput`'s private extraction — one extractor, two consumers).
- Chat runs (`kind === "chat"`) never create artifacts — same exclusion already applied to the Inbox.
- Idempotency: creation is keyed by `runId`; re-folding or re-serving a run must not create a duplicate (test this).

### A4. API routes (admin-gated, added to the `routes` table in `server.ts`)

```
GET    /api/artifacts                 ?agentId=&archived=&q=&limit=&before=   newest-first
GET    /api/artifacts/:id
PATCH  /api/artifacts/:id             { archived?, read? }
DELETE /api/artifacts/:id
POST   /api/artifacts/:id/share      → { url, token }  (mint/rotate; hash stored, token shown once)
DELETE /api/artifacts/:id/share      revoke
GET    /api/share/:token              PUBLIC — served without session (allowlist it in the auth
                                      gate exactly the way /api/triggers/:agentId is allowlisted).
                                      Constant-time lookup by sha256(token). Returns
                                      { title, body, format, agentName, createdAt } — never runId,
                                      never internal ids. Rate-limit like the trigger route.
```

### A5. Web UI

- **`web/app/inbox/page.tsx` → artifact-backed.** Fetch `/api/artifacts` instead of walking runs; delete `extractOutput`, the lazy `getRun` hydration, and the two localStorage sets (read/archive now `PATCH`). Keep the existing card layout, search, agent filter, and design tokens. One-time niceness: if localStorage keys exist, fire best-effort PATCHes to migrate read/archive state, then clear them.
- **New `web/app/outputs/[id]/page.tsx` — the rendered artifact page.** Title, agent name, timestamp; body rendered as markdown when `format === "markdown"` (a small internal renderer or a permissively-licensed dep in `web/` only — core stays zero-dep; **no `dangerouslySetInnerHTML` over raw HTML — sanitize or render to React nodes**); actions: copy, archive, share toggle (shows the one-time link), and a quiet "How this was made → run record" link to `/runs/[runId]`. This page is the product's face — apply `frontend-design` care, all tokens from `globals.css`, no cost shown anywhere.
- **New `web/app/share/[token]/page.tsx` — public.** Read-only rendering via `GET /api/share/:token`, no nav chrome, no admin links, small "Made with Krelvan" footer. Must be excluded from the session middleware (`web/middleware.ts`).
- Nav: "Inbox" stays; run detail gains an "Output" chip linking to the artifact when one exists.

### A6. Tests & acceptance

`node:test` coverage: output-map parsing; extractor precedence (map beats heuristic; malformed map falls back); store CRUD + share mint/verify/revoke + constant-time property; runtime integration (completed run with `output_map` → artifact exists, delivery got identical title/body; chat run → no artifact; duplicate-completion → one artifact). Playwright screenshots (desktop + mobile) of Inbox, artifact page, and share page — per AGENTS.md rule 1, UI is done only when *looked at*.

**Accept when:** a fresh `price-monitor` install completes a run → artifact card in Inbox → opens rendered → share link works logged-out → revoke kills it (404) → run record reachable from the artifact. Full suite green.

---

# Workstream B — Agent Front Door

**Goal:** an agent is reachable from outside the admin panel: a synchronous ask endpoint, a public agent page, and an embeddable widget. Depends on A (the ask endpoint returns artifact-shaped output).

### B1. Public identity: slug + publish flag

`AgentRecord` (in `runtime.ts`) gains `slug: string` (unique; generated from name — lowercase, hyphens, 4-char suffix on collision; slugify util + tests) and `public: { enabled: boolean; showFeed: boolean; chat: boolean; siteKeyHash?: string }`, default all-off. **Deny-by-default is the law here (AGENTS.md rule 9): nothing is public until the owner flips it.** Admin routes: `GET/PUT /api/agents/:id/public`; enabling with `chat: true` mints a **site key** (`pk_` + random; hash-only storage; shown once; rotate = re-mint) — a *public* credential, deliberately weaker than the trigger token: it can only start chat turns and read the public feed for that one agent.

### B2. Public API surface (all allowlisted past the session gate, all rate-limited per IP+agent, reusing the trigger route's limiter)

```
GET  /api/public/agents/:slug            → { name, intent-one-liner, chatEnabled, feedEnabled }; 404 unless enabled
GET  /api/public/agents/:slug/feed       → published artifacts (see B4), title+body+createdAt only
POST /api/public/agents/:slug/ask        → body { message, thread?, siteKey }
       Verifies siteKey (constant-time). Starts a chat run via the existing handleChat
       machinery (kind:"chat", inbox-excluded). Waits up to KRELVAN_ASK_TIMEOUT_MS
       (default 25000) for completion → 200 { reply, thread }.
       Still running at timeout → 202 { thread, poll: "/api/public/agents/:slug/ask/:thread" }.
       Parked for approval → 202 { status: "awaiting-approval" } — the human gate is honored
       verbatim in public; a public caller can NEVER approve anything.
GET  /api/public/agents/:slug/ask/:thread → poll endpoint for the 202 path
```

Hard constraints: public chat turns run under the agent's existing grants — the public surface adds **zero** capability widening (compiler monotonicity's spirit at the API layer). Per-thread and per-key run caps (env-tunable, sane defaults) so an exposed instance can't be cost-drained; when a cap trips, respond 429 — never surface cost or budget numbers (AGENTS.md rule 3 applies to public surfaces too).

### B3. Public agent page — `web/app/a/[slug]/page.tsx`

Agent name + one-liner; if `showFeed`, the published-artifact feed (cards → public share rendering); if `chat`, a chat panel talking to `/ask` (thread kept in memory, not localStorage — artifacts guidance applies to web too). No admin chrome; excluded from session middleware. This is the "your agent is live" moment — design it like a product page, not a console.

### B4. Publishing artifacts to the feed

`ArtifactRecord` gains `published: boolean` (default false). `PATCH /api/artifacts/:id { published }` (admin). Artifact page and Inbox cards get a "Publish to agent page" toggle, visible only when the agent's public feed is enabled. Feed endpoint returns only `published && !archived`.

### B5. Embeddable widget

`web/public/widget.js` — dependency-free vanilla script (it runs on *other people's* sites):

```html
<script src="https://your-host/widget.js" data-agent="support-bot" data-key="pk_…"></script>
```

Renders a launcher bubble → chat panel; talks only to the `/ask` endpoints; namespaced styles (shadow DOM); graceful failure if the agent is disabled. Keep it small (≈4 KB min). The agent's public-settings admin page shows the copy-paste snippet. CORS: `/api/public/*` responds `Access-Control-Allow-Origin: *` — these routes are authenticated by site key, not cookies, and carry no session (document this deviation from `CORS_ORIGIN` in a comment where it's set).

### B6. Tests & acceptance

Route tests: 404-when-disabled, constant-time key verify, rate limits, ask sync/async paths, approval parking (a `suggest`-gated node parks the public ask; nothing sends until approved in the admin Approvals page), feed shows only published. Widget: Playwright loads a bare HTML page embedding it against a live dev instance; screenshot desktop + mobile.

**Accept when:** enable public on the RAG Support Bot → `/a/support-bot` loads logged-out → widget on a blank page answers a doc question → an approval-gated send parks publicly and releases from admin → disabling kills page, feed, ask, and widget instantly.

---

# Workstream C — Scheduler v2 ("scheduled runs done right")

**Goal:** schedules are creatable in plain English at build time, survive downtime predictably, can't silently break, and show their history. Upgrades `src/api/scheduler.ts` in place.

### C1. Correctness fixes (do these first — they're bugs, not features)

1. **Timer overflow.** `setTimeout` above 2³¹−1 ms (~24.8 days) fires immediately — a monthly/yearly cron misfires today. In `Scheduler.arm`, cap each timer at `MAX_ARM_MS = 6h` and re-arm on wake until the real due time (sleep-chaining). Test with injected fake timers.
2. **Missed runs across downtime.** `ScheduleRecord` gains `onMissed: "skip" | "runOnce"` (default `"skip"`). In `start()`: if `enabled && nextRunAt < now`, either advance silently (skip) or fire exactly one catch-up run then re-arm (runOnce — right for daily digests). Persist `nextRunAt` before arming (already done) so the boot check is meaningful.
3. **Timezone honesty.** Cron evaluates in server-local time. Minimum: `GET /api/status` exposes the server IANA timezone; the Schedules UI displays "runs in <tz>" and every `nextRunAt` in both server and browser time. (Full per-schedule tz is a later, isolated enhancement — the field can be added now as optional and ignored.)
4. **Failure visibility.** Track `lastStatus: "completed" | "failed" | "halted"` and `failStreak: number` on the record, updated when the scheduled run finishes (see C2 for attribution). After `failStreak >= 3`, keep the schedule armed but surface a warning state; deliver a one-line notice through the agent's existing `deliverTo` targets ("Your schedule '<label>' has failed 3 times — latest reason: …").

### C2. Attribution: scheduled runs know their schedule

`RunRecord` gains `origin?: { kind: "manual" | "schedule" | "trigger" | "public-ask"; scheduleId?: string }`. Set it in `startScheduledRun` (`runtime.ts` ~1776), the webhook trigger handler, and the public ask path; default `manual`. This powers: `GET /api/schedules/:id/runs` (filter `runRegistry` by `origin.scheduleId`, newest-first, limit 20), artifact `scheduleId` stamping (A1), and an "every Monday 08:00 · from schedule" chip on run detail and artifact pages. Old records without `origin` render as manual — no migration needed.

### C3. Natural-language scheduling in the builder

Two-layer parse, deterministic first (matching the codebase's LLM-is-untrusted posture):

- **New pure module `src/core/manifest/schedule-phrase.ts`:** `parseSchedulePhrase(text) → { kind, spec, label } | null` covering the high-frequency forms — "every day at 8[:30] [am|pm]", "every weekday at …" (`0 8 * * 1-5`), "every Monday…Sunday at …", "every hour", "every N minutes/hours", "daily/weekly/hourly". Exhaustive table-driven tests. No LLM, no eval — string → validated cron via the existing `parseCron`.
- **Compiler assist for the long tail:** in the build prompt, ask the model to emit an optional `schedule: { spec, label } | null` alongside the manifest. The proposal is untrusted data: accept only if `validateCron(spec)` passes (extend to intervals with a floor of 60 000 ms); otherwise drop it. The deterministic parser's answer, when present, always wins over the model's.
- **Build flow (UI in `web/app/_builder.tsx`):** when the intent parses to a schedule, the plan-confirmation step shows a schedule card — "Runs every weekday at 08:00 (server time). Deliver to: [Inbox ✓] [Email] [Slack] [Telegram] …" — with delivery pickers writing to the agent's existing `deliverTo` via `PUT /api/agents/:id/delivery`. Confirming creates agent + schedule (`POST /api/schedules`) + delivery in one flow. The first run can be offered immediately ("Run once now so you see tomorrow's format?") — that first artifact landing in the Inbox is the retention hook.

### C4. Schedules UI upgrade (`web/app/schedules/page.tsx`)

Per schedule: label, human-readable spec ("every weekday at 08:00" — reverse-render common crons, else show the raw spec in `.mono`), next-run countdown, last-run status dot (OK green `--ok` / failed `--danger` / warning at streak ≥ 3), enable/disable, **Run now** (calls the same `startScheduledRun` path so origin attribution holds), and an expandable last-10-runs history from C2's endpoint, each row linking run + artifact. Amber is reserved for live/running state only, per the design rules.

### C5. Tests & acceptance

Fake-clock tests for sleep-chaining and both `onMissed` policies; phrase-parser table tests; compiler test that an intent like "email me a competitor digest every weekday at 8am" yields manifest + valid schedule + `output_map`; integration: scheduled fire → run has `origin.scheduleId` → artifact stamped → delivery fired → history endpoint shows it; failure-streak test (3 fake failures → warning state + one notice delivery, schedule still armed).

**Accept when:** typing the digest intent above into the builder produces an agent, an armed schedule visible with countdown, a chosen email target — and after "Run now", an artifact in the Inbox, an email delivery attempt logged, and a history row on the schedule. Kill the process past a due time and restart: `skip` advances, `runOnce` fires exactly one catch-up. Full suite green.

---

## Sequencing & guardrails

**Order: A1–A3 → A4–A6 → C1–C2 → B1–B2 → C3–C4 → B3–B5 → C5/B6 polish.** (C1/C2 are small and unblock artifact attribution; B's ask endpoint returns artifact-shaped output so A must land first.)

Non-negotiables carried from `AGENTS.md` into every task: no `eval` (schedule phrases and output maps are parsed data); kernel/core additions stay pure (no clock/random in `src/core/`); no floats or costs anywhere user-visible; deny-by-default on every public surface; hash-only credential storage with constant-time compare; design tokens only, amber = live only; and rule 1 — nothing is "done" until the test ran and the screenshot was looked at. When any template manifest changes (A2), update its test rig in the same commit — that's the drift class that produced the 9 failures found in review.

**Explicitly out of scope here** (fast follows, don't let them creep in): inbound email/Telegram *channels* (webhook trigger + public ask cover inbound for now), per-schedule timezones, PostgreSQL/multi-tenant, marketplace publisher signing, hosted offering.

---

## Build status — what was actually shipped (2026-07)

**Workstreams A, B, and C are complete.** Full suite green (526 tests; 1 requires Ollama and
skips without it), both typechecks clean, web build green, launch surfaces screenshot-verified
(archived under `web/audit/`).

| Workstream | Status | Where |
|---|---|---|
| A — Artifacts & Deliverables (A1–A6) | ✅ complete | `artifact-store.ts`, `artifact-extractor.ts`, `output-map.ts`, `web/app/inbox`, `/outputs/[id]`, `/share/[token]` |
| B — Agent Front Door (B1–B6) | ✅ complete | slug/site-key in `runtime.ts`, `/api/public/*` in `server.ts`, `web/app/a/[slug]`, `web/public/widget.js`, admin Public panel |
| C — Scheduler v2 (C1–C5) | ✅ complete | `scheduler.ts`, `schedule-phrase.ts`, `web/app/schedules`, builder schedule card |

Acceptance journeys are automated as e2e in `src/api/acceptance.test.ts` (A: run → inbox →
rendered → share → revoke → 404 → run reachable; B: enable → page → ask → disable kills
everything). The public-surface security posture is in `src/api/public-surface.test.ts` and
documented in `docs/PUBLIC_SURFACE.md`.

### Deviations from this plan (the truth about what was built)

1. **Site-key storage (B1/B3).** The plan said hash-only. But B3's `/a/:slug` page and the widget
   both need the plaintext key to chat, and the key is *public by design*. So the plaintext is
   stored **encrypted** (AES-256-GCM) in the secret store under a reserved `__sitekey__<agentId>`
   name; `agents.json` still keeps only the hash. Reserved secrets are hidden from the admin list.
   The full trust model is in `docs/PUBLIC_SURFACE.md`.
2. **Proxy CORS for `/api/public/*` (B5).** The widget runs cross-origin on third-party sites, so
   the same-origin proxy was given `Access-Control-Allow-Origin: *` (response + OPTIONS preflight)
   for public paths only. Not in the plan's letter; required for the widget to work.
3. **Approvals visibility fix (found in C5).** Public-ask runs are `kind:"chat"`, which the runs
   list excludes — so a parked public ask was invisible in the admin Approvals page. Fixed:
   `listPendingApprovals` now uses `listHalted()` (includes chat runs). Covered by a C5 e2e test.
4. **Publish toggle placement (B4).** Put on the artifact page (its natural home); the inbox-card
   variant the plan also mentions is a fast-follow (per-card public-config lookups are an N+1).
5. **`validateManifest` note severity (A2).** Added an optional `severity: "note"` + `fatalIssues()`
   so the output_map "unknown node" note is genuinely non-fatal (doesn't block install), rather than
   forcing it into the fatal issue list.
6. **Test-count claims softened.** Doc status lines say "all tests pass (1 requires Ollama…)"
   instead of a hardcoded number that goes stale; exact counts live in commit messages.

### Manual-check list (not automatable)

Verified by looking at screenshots (`web/audit/`), re-check on any UI change:

- `/a/:slug` and the widget render with **no admin chrome** (also asserted in the e2e DOM check).
- The widget mounts + chats **cross-origin** from a real served origin (Chrome's Private Network
  Access blocks the `data:`→loopback dev case, so this is checked from a served page).
- A **real** chat answer needs a configured LLM; without one the full request/park/reply mechanism
  runs and returns the graceful "couldn't answer just now" fallback.

### Still out of scope (unchanged)

Inbound email/Telegram channels, per-schedule timezones, PostgreSQL/multi-tenant, marketplace
publisher signing, hosted offering. **Workstream D not started.**
