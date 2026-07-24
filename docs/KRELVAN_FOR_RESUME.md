# Krelvan — Complete Feature Inventory, Roadmap & Resume Entry

*Code-verified June 2026. Every claim below was checked against the actual source in
`/Users/sreenath/Code/myAIExps/genesis-new/src` and `/web`, not the marketing docs.
Spine: `docs/FEATURE_MAP_VERIFIED.md` (a prior line-by-line 10-agent scan), re-verified and
extended here with the items that scan left unaudited (NavClient, agents/[id], MemoryTab) and
the auth + DNS-SSRF subsystems that have landed since.*

**Verified ground-truth numbers**
- **82 TypeScript source files** in `src/` (incl. tests + demos); ~14K LoC of core.
- **193 tests, 190 pass, 3 fail** (`npm test`). The 3 failures are *live-model API-key* tests
  (`adapters/anthropic-model.test.ts` — "parses a clean JSON manifest", and two
  MODEL+COMPILER cases) that require a real Anthropic key; they are environmental, not logic
  failures. 3 suites.
- **7 LLM providers** in one client (`src/adapters/llm-client.ts`).
- **Marketplace:** 7 capabilities published in the GitHub registry index
  (`registry/index.json` → `capabilities[]`), plus ~11 local YAML capabilities in
  `capabilities/*.yaml` and 13 built-in capability plugins in `src/core/plugins/`. (The
  often-cited "15" reflects local+bundled seed; the *published* index holds 7 — stated
  honestly here.)
- **Zero runtime dependencies in the core** beyond `tsx`; Node built-ins only
  (`node:crypto`, `node:sqlite`, `node:http`, `node:dns`, `node:net`).

Status legend: **[real-enforced]** = code does what it claims and is wired into live paths
(usually tested) · **[partial]** = works with a material caveat · **[aspirational]** =
stub / unwired / doc-only.

---

# SECTION 1 — COMPLETE FEATURE INVENTORY

## 1. Ledger & Cryptographic Core — `src/core/ledger`
The strongest subsystem. Single-tenant tamper-evidence is genuinely real and tested.

- **[real-enforced] Content-addressing over the full preimage** — the event id hashes
  type/scope/parents/prev/offset/payload/determinism/ts/author (not just payload). Re-parenting
  or repositioning an event changes its id. (`event.ts`, `canonical.ts`)
- **[real-enforced] Canonical serialization** — deterministic key sort, `undefined` omission,
  idempotent; rejects non-plain prototypes. (`canonical.ts`)
- **[real-enforced] Numeric safety** — throws on float/NaN/Infinity/bigint/unsafe-int; forces
  money/counts to integers. (`payload.ts`)
- **[real-enforced] SHA-256 content addresses**, algorithm-tagged `sha256:<hex>`. (`crypto.ts`)
- **[real-enforced] HMAC-SHA256 signing over the content address (id), not the raw object.**
- **[real-enforced] Hash-chain linkage + contiguous offsets** assigned inside an append lock;
  `verify()` catches gap / dup / broken-chain. (`ledger.ts`, `sqlite-store.ts`)
- **[real-enforced] Tamper-evidence via id recomputation** in `verify()` and on-disk
  `selfCheck()` — mutate any stored field → HashMismatch / BrokenChain / OffsetGap / BadSignature.
- **[real-enforced] Author == signer == sig keyId**; dangling-parent rejection; determinism tag
  (only an EffectResult may be `captured`).
- **[real-enforced] Atomic CAS append, no forks** — in-memory per-tenant mutex + SQLite
  `BEGIN IMMEDIATE` + `PRIMARY KEY(tenant, offset)`; a 50-way concurrent append test passes.
- **[real-enforced] On-disk durability + restart recovery** — SQLite WAL, `synchronous=FULL`;
  survives close/reopen. *(Caveat: `node:sqlite` is experimental on Node 22.)*
- **[real-enforced] Typed `Result` error model** — no silent failures; any verify failure
  surfaces as UNVERIFIABLE. (`errors.ts`)
- **[partial] Key validity windows / rotation** — epoch + validFrom/validUntil enforced, but
  validity is resolved from the *signer-supplied* `sig.signedAt`, not a trusted clock → a
  revoked-secret holder could backdate inside the old window.
- **[partial] HMAC is offline single-owner only** — verifier holds the same secret it verifies:
  tamper-evidence yes, **non-repudiation no**. Asymmetric/hardware trust root is comment-only.
- **[partial] `timingSafeEqualHex`** — hand-rolled constant-time compare in the ledger path
  (note: the newer auth path uses `crypto.timingSafeEqual` proper).
- **[aspirational] Tail-truncation checkpoint (LED-07)** — `checkpoint.ts` referenced but does
  not exist; no production path builds/signs a checkpoint.
- **[aspirational] Hash-algo agility, NFC unicode normalization, "notarized now"** — doc-only;
  `HASH_ALGO` is hardcoded sha256, no `normalize()` anywhere, `verify()` takes no `now`.

## 2. Kernel & Engine — `src/core/kernel`
Deterministic `decide()` + an event-sourced engine. The load-bearing crash-safety claims hold.

- **[real-enforced] `decide()` purity** — no I/O / clock / randomness; a restricted expression
  evaluator (`manifest/expr.ts`), never `eval`; the sole decision authority. (`kernel.ts`)
- **[real-enforced] 3-event effect protocol** (AdmissionDecision → EffectRequested →
  EffectResult) with correct signer separation: orchestration is owner-signed, EffectResult is
  **supervisor-signed**, plugins never sign; the plugin's claim travels as untrusted data.
- **[real-enforced] Projection / fold** — one `applyEvent` transition shared by `project()` and
  the incremental folder. (`project.ts`, `incremental-fold.ts`)
- **[real-enforced] Incremental fold** — checkpointed hot path with safe fallback; deep-copies
  to avoid aliasing.
- **[real-enforced] Crash-resume / no double-execution** — all state lives in the ledger;
  RE-SERVE skips any idempotency key already in results; key = hash(nodeId, capability). Proven
  across two engine "lives" for both effects and sub-agents. (`engine.ts`, `kill-and-resume` demo)
- **[real-enforced] Reserve-then-settle budget gating** — denies if projected run/per-cap spend
  exceeds the ceiling (counts open reservations); negative cost clamped; single RunFailed on deny.
- **[real-enforced] Approval park / autonomy gradient (HITL)** — appends AwaitRequested *before*
  any admission/reservation, parks with no budget footprint, resumes via AwaitResolved.
- **[real-enforced] Sub-agent path (agent-as-capability)** — deterministic subRunId, separate
  ledger, budget capped to the reservation, output mapping, monotone authority; idempotent
  re-serve proven. (`sub-agent-executor.ts`)
- **[partial] Crash-hole HALT** — `crashHoles()` forces a halt-first in `decide()`; correct but
  no unit test exercises the hole path.
- **[partial] Loop bound (`maxNodeVisits`)** — off-by-one: the check fires after the visit
  counter is incremented, so the minimum usable value is 2; tests use 5.
- **[partial] Float-output sanitization** — `sanitizeOutput` guards EffectResult/SubRunCompleted,
  but NodeConcluded state is built from un-sanitized output, so a float scalar can still crash a run.
- **[aspirational] `validateSubAgentBinding`** — best-effort, never called on the execution path.
- **[aspirational] Engine `case 'conclude'`** — dead code; `decide()` never returns it.

## 3. Capability Plane — `src/core/capability`, `extensions/yaml-capability.ts`, `directory-loader.ts`
The pure in-kernel decisions are real and trustworthy. The impure egress/cost/secret boundaries
are still mostly aspirational — **but the SSRF boundary has now been closed (see §13).**

- **[real-enforced] Deny-by-default admission** — a capability must be explicitly declared in the
  node manifest; null estimate (plugin absent/disabled) → CAPABILITY_NOT_GRANTED. (`capability.ts`)
- **[real-enforced] Run-level + per-node-cap budget ceilings** — reserve-then-settle, counting
  open reservations so concurrent calls can't jointly overflow.
- **[real-enforced] Negative-cost clamp** — `Math.max(0, costCents)`.
- **[real-enforced] Side-effect taxonomy + `needsApproval` gradient** — whitelist-validated;
  read = never gates, suggest = gates all, act-with-veto = gates write-irreversible/spend/
  identity-mutation, full = never gates. Genuinely wired to the engine's AwaitRequested park.
- **[real-enforced] Plugin never self-signs EffectResult** — the supervisor (distinct key) signs;
  the plugin claim is kept as separate untrusted data.
- **[real-enforced] No-eval whitelist interpolation** — only `{{secret:name}}` / `{{input.field}}`,
  safe dot-paths; no Function/eval/prototype access.
- **[real-enforced] Integer-cents validation** + handle-gated atomic snapshot swap of the registry.
- **[real-enforced] Directory auto-loader** — scans `capabilities/` for mcp-servers.json / `.yaml`
  / `.js`-`.ts` with per-file error isolation. (`directory-loader.ts`)
- **[real-enforced — NEW] YAML/HTTP capability now runs through the DNS-SSRF guard** —
  `yaml-capability.ts:488` calls `assertPublicUrl(url)` before fetching. This closes the gap the
  prior scan flagged as "[stub] YAML SSRF protection: NONE."
- **[partial] YAML capability HTTP execution** — real `fetch()`, successCodes check, responseField
  extraction; but `claimedCostCents` is hardcoded to `estimateCents` (no measured cost).
- **[partial] successCodes/responseField/type validation** — structural only; declared output
  fields are not validated against the actual response.
- **[partial] Custom YAML parser** — restricted, hand-rolled; silently drops over-indented lines
  and coerces numeric-looking scalars.
- **[aspirational] Supervisor "co-signs MEASURED cost"** — no egress metering / token counting;
  the supervisor rounds and re-labels the plugin's self-claim.
- **[aspirational] Arbitrary JS/TS capability execution isolation** — `loadJsCapabilities` does a
  bare `await import()` of any dropped file in-process with full host privileges; no real sandbox.
- **[aspirational] "Broker mints scoped tokens / plugin never holds raw secrets"** — false on the
  live path; raw secrets are interpolated directly into outgoing requests.

## 4. Plugin Lifecycle & Loaders — `src/core/plugins/*`, `src/infrastructure/plugins/*`
Lifecycle integrity (atomicity, hash-pinning, state machine) is genuinely strong. Isolation and
secret delivery are not.

- **[real-enforced] `install()`** — path containment (absolute-resolve inside `pluginsRoot`),
  existsSync, sha256 hash, dry-load to discover the self-declared name, name regex, dedup; persists
  "installed" without loading. (`lifecycle-service.ts`)
- **[real-enforced] `enable()` / `disable()` / `uninstall()`** — hash re-check (SOURCE_CHANGED),
  MISSING_SECRETS preflight, atomic registry-row + ledger-event in one `BEGIN IMMEDIATE`, then
  snapshot pointer-swap, then teardown. Uninstall has a pending-commitments guard (open
  EffectRequested w/o EffectResult across all tenants → blocked).
- **[real-enforced] Startup re-activation** — `PluginActivator.loadAll` re-hashes every enabled
  plugin; a bad plugin is disabled + PluginLoadFailed and cannot block boot. (`plugin-activator.ts`)
- **[real-enforced] Source-hash pinning** end-to-end, recorded into every lifecycle event payload.
- **[real-enforced] DelegatePlugin (sub-agent delegation)** — monotone budget narrowing
  (`Math.min`, same principal), fresh isolated engine, supervisor co-signs sub-run results.
- **[real-enforced] Worker teardown / in-flight rejection** — terminates the worker, rejects
  pending calls, post-teardown invoke throws.
- **[real-enforced] SqlitePluginRepository** — flat-column registry, UPSERT, corruption guards,
  hard-delete on uninstall. (`infrastructure/plugins/sqlite-plugin-repository.ts`)
- **[partial] TS worker isolation** — one long-lived Worker per enable; thread + module-cache +
  wall-clock-timeout isolation only (no `resourceLimits`, no fs/network jail).
  (`infrastructure/plugins/typescript-plugin-loader.ts`)
- **[partial] Delegation HITL** — DelegatePlugin hardcodes `approve:()=>true`, auto-approving every
  gated effect in the sub-run; authority/budget are capped, the approval gate is not.
- **[aspirational] Worker resource/network/fs sandbox** — a malicious TS plugin keeps full ambient
  `fetch`/`fs`/`child_process`/`process.env`.
- **[aspirational] TS-plugin secret delivery** — broken end-to-end; the worker handler ignores
  `msg.secrets`.

## 5. Built-in Capabilities — `src/core/plugins/`
All make real external calls / disk I/O — none are mocks.

- **[real-enforced] `think` / `compose` / `llm_route`** — real LLM calls, token-based costing;
  `llm_route` clamps the model's choice to declared candidates. (`think.ts`, `compose.ts`,
  `llm-route.ts`)
- **[real-enforced] `telegram_send` / `slack_send`** — real Bot API / Incoming Webhook POSTs.
- **[real-enforced] `recall` / `identify`** — real atomic JSON-file persistence; `identify`
  correctly classified `identity-mutation`. (`memory-plugins.ts`)
- **[real-enforced] `text_transform`** — pure inline transform.
- **[real-enforced — NEW] `http_get` / `http_post` / `notify_webhook` SSRF guard** — now call
  `assertPublicUrl()` with full DNS resolution (`http-get.ts`, `http-post.ts`, `notify-webhook.ts`).
- **[partial] `web_search`** — Brave path is real; the LLM-fallback path returns model recall
  (`synthetic:true`, empty url) labeled as a search result. (`web-search.ts`)
- **[partial] `email_send`** — real Resend + hand-rolled ESMTP; the SMTP path is plaintext over
  `node:net` with no TLS/STARTTLS. (`email-send.ts`)
- **[partial] `remember`** — real disk write but declared `sideEffect:'read'` while writing files,
  so the autonomy gate never requires approval.
- **[aspirational] Supervisor cost "observation"** — accepts the plugin's self-reported cost.
- **[partial] Built-in secret usage** — built-ins read credentials straight from `process.env`,
  bypassing the broker port.

## 6. Compiler / Manifest / Memory — `src/core/compiler`, `src/core/manifest`, `src/core/memory`
The compiler is where the headline security property lives, and it is real.

- **[real-enforced] Capability monotonicity (the security core)** — `compiler.ts` checks that an
  untrusted principal (`channel` / `agent` / `memory`) can NEVER add a capability, raise a budget,
  or smuggle a spend under a read name; only `owner`-authority may widen. This is the structural
  prompt-injection / privilege-escalation defense, tested. (`compiler.ts:40-104, 133`)
- **[real-enforced] LLM output treated as untrusted data** — the compiler parses, validates and
  signs; an invalid or malicious proposal is rejected at the `monotonicity` / `validate` / `expr`
  stage rather than executed.
- **[real-enforced] Manifest signing binds provenance** — swapping principal/intent invalidates
  the signature. (`manifest/manifest.ts`)
- **[real-enforced] Safe expression AST** — `manifest/expr.ts`: a typed evaluator with genuinely
  no `eval`/`Function` anywhere.
- **[real-enforced] Memory model — semantic facts / episodes / soul with provenance** — disk-
  persisted, atomic; provenance tags (`owner`, `tool-observed` = trusted; `channel`/`agent`/
  `memory` = quarantined) are surfaced. (`memory/memory.ts`)
- **[aspirational] Memory-as-ledger-projection in production** — the live runtime serves/clears
  memory from standalone `.semantic.json`/`.episodes.json`; `projectMemory()` has no non-test
  callers. The `consequentialFacts`/`isTrusted` trust gate exists in code (and is mirrored in the
  UI, §11) but is not enforced on a live consequential-decision path in the backend.

## 7. MCP — `src/core/mcp`
- **[real-enforced] MCP client** — JSON-RPC over stdio / HTTP, tool discovery, tool →
  CapabilityPlugin mapping; actually wired into the runtime. (`mcp-client.ts`)
- **[partial] MCP transport** — stdio `request()` has no timeout; HttpMcpTransport hardcodes
  JSON-RPC `id:1` (no correlation), no auth headers.
- **[aspirational] MCP side-effect inference** — fails OPEN to `read` for any unrecognized tool,
  so a destructive tool can bypass the approval gate unless a per-tool override is set.

## 8. Identity / Secrets / Time — `src/core/identity`
- **[real-enforced] Key lifecycle (issue/rotate/revoke)** — windowed verify; out-of-window →
  typed reason; history stays verifiable. (`identity.ts`)
- **[real-enforced] MonotonicClock** — never goes backward; signed-tick verifies. *(Standalone.)*
- **[partial] Revocation** — closes the window but does not kill already-emitted in-window
  signatures (no revocation list).
- **[aspirational] `SecretBroker` (identity.ts), InteractionResolver, IdentityManager,
  MonotonicClock** — implemented and unit-tested but unwired (imported only by their own tests).
  The "approval IS authorization / mints the grant atomically" narrative is not on the live path.

## 9. Channels & Observability — `src/core/channels`, `src/core/observability`
- **[real-enforced] Observability pure folds** — canvasView / costView / timelineView; a
  tamper-detecting `verificationReplay` (flip a payload → UNVERIFIABLE); a span tracer used by the
  engine; a structured logger. (`observe.ts`, `spans.ts`, `logger.ts`)
- **[real-enforced] Channel abstraction** — `channel.ts` with tests.
- **[partial] `verificationReplay` "reconciliation"** — re-sums the same log's recorded costs
  (not cross-source). `planCounterfactual` executes nothing and never re-gates.
- **[partial] OTEL** — span tracer is real, but there is no OTEL exporter; the only sink is the
  logger.
- **[aspirational] Observability user surface via `observe.ts`** — imported only by tests; the UI
  builds its own folds from raw events instead (so the UI views DO exist — see §11).

## 10. API Server, Runtime & Adapters — `src/api/*`, `src/adapters/*`
The live runtime. Most user-facing features are real.

- **[real-enforced] HTTP API server + router** — `node:http`, ~40 routes, hand-rolled multipart
  upload, top-level error → 500. (`server.ts`)
- **[real-enforced] SecretStore (AES-256-GCM at rest)** — per-value IV + auth tag, masked list,
  env fallback; tested. (`secret-store.ts`)
- **[real-enforced] 7-provider LLM client** — Anthropic / OpenAI-compatible (openai, groq, mistral)
  / Ollama / Gemini, each provider-correct; unknown → Anthropic fallback. (`llm-client.ts`)
- **[real-enforced] HTTP retry with backoff** — retryable status set, full-jitter, Retry-After,
  per-attempt timeout; tested. (`http-retry.ts`)
- **[real-enforced] AnthropicModel compiler adapter** — treats LLM output as untrusted data; the
  compiler validates + signs. (`anthropic-model.ts`)
- **[real-enforced] Builder self-correction loop** — up to 3× recompile with error feedback folded
  into a separate augmented intent (clean intent never pollutes stored provenance).
- **[real-enforced] Diagnose / retry-with-fix / explain / explain-build** — real LLM reasoning
  grounded in the signed ledger; retry produces a genuinely rebuilt corrected agent.
- **[real-enforced] Run execution + SSE streaming** — fire-and-forget `executeRun`; SSE polls the
  ledger every ~400 ms with heartbeats.
- **[real-enforced] HITL approvals** — pairs AwaitRequested/AwaitResolved across halted runs;
  double-resolve race guard.
- **[real-enforced] Scheduler** — zero-dep cron parser + interval, persisted, re-arms on boot
  (single process, no leader coordination). (`scheduler.ts`)
- **[partial] LLM cost estimation** — curated prefix→rate table; returns 0 for
  ollama/groq/mistral/compatible/unmatched models, so budget enforcement is weak on those.
- **[partial] Persistence** — agents/runs use atomic tmp+rename, but `CapabilityRegistry.persist`
  and `ScheduleRegistry.persist` use non-atomic `writeFileSync`; a mid-run crash leaves a run
  stuck `running` with no reconciliation.
- **[partial] Ledger signing secrets** — the demo runtime still uses fixed HMAC secrets with
  `validUntil:null`; tamper-evidence is only as strong as that constant.
- **[aspirational] AnthropicDistiller** — implemented + tested but never instantiated by the runtime.

## 11. Web UI — `web/app`, `web/lib` (Next.js 15)
A real Next.js client; every endpoint it calls maps to a concrete server handler — nothing mocked.

- **[real-enforced] Full product surface** — NL builder + build-preview modal, dashboard, run trace
  (Output / Graph / Timeline / State / Explain) with SSE + polling fallback, auto-explain/diagnose/
  retry-with-fix, interactive canvas (pan/zoom/scrub/blueprint-live/heat-map), approvals inbox,
  capabilities install/enable/disable/remove/view+edit-source, MCP connect/disconnect, secrets
  set/delete, schedules CRUD, runs list.
- **[real-enforced] Autonomy simulator honesty** — the UI's `needsApproval()` (`web/lib/
  sideEffects.ts`) is byte-for-byte the engine's `needsApproval()` (`capability.ts`), so the
  approval simulator is accurate.
- **[real-enforced — VERIFIED HERE] `agents/[id]/page.tsx`** — a substantial agent-detail page
  (~970 lines): run history, canvas, memory tab wiring.
- **[real-enforced — VERIFIED HERE] `MemoryTab.tsx`** (~600 lines) — renders soul/identity,
  semantic "beliefs" with version + source-run links, and an episodic "run diaries" timeline. It
  surfaces the provenance trust model directly: trusted (`owner`/`tool-observed`) vs **quarantined**
  (`channel`/`agent`/`memory`) facts get distinct styling and a banner stating quarantined facts
  "never authorize a consequential action." Includes a guarded clear-all-memory dialog. *(This is a
  faithful presentation of the trust model; the backend enforcement of that gate remains §6's gap.)*
- **[real-enforced — VERIFIED HERE] `NavClient.tsx`** — full primary/utility nav with an active-link
  sliding indicator, running-count badge, and a ⌘K command palette (navigation over static commands).
- **[partial] Marketplace Discover** — remote GitHub `index.json` (`cache:no-store`) with a bundled
  seed fallback; the remote-vs-bundled source flag is computed but not shown.
- **[partial] "Signed" / Verified badges** — presentational; the UI does not verify signatures
  client-side, it trusts the backend.
- **[aspirational] Approval risk labels, HeroAnimation hashes, build-stage progress strings** —
  cosmetic / marketing-only.

## 12. Security & Auth — `src/api/auth.ts`, `web/app/proxy/[...path]/route.ts` (NEW SUBSYSTEM)
This is the largest change since the prior scan, which had flagged "NO authentication on ANY route"
as the single biggest gap. **That gap is now closed (Phase 1).**

- **[real-enforced] Secure-by-default bearer token (PocketBase/Jupyter model)** — on first start,
  if no token is configured, `initAuth()` generates a 256-bit random token, persists ONLY its
  SHA-256 hash to `<dataDir>/auth.token` (chmod 600), and returns the plaintext once so the launcher
  can print it. Plaintext is never stored. An env token (`KRELVAN_AUTH_TOKEN`) takes precedence for
  CI/reproducible deploys. (`auth.ts:44-76`)
- **[real-enforced] Auth gate before routing** — `server.ts:245` calls `authenticate()` before
  `matchRoute`; every route requires `Authorization: Bearer <token>` except a tiny public allowlist
  (`GET /api/health`). Comparison is constant-time via `crypto.timingSafeEqual` over SHA-256 hashes.
- **[real-enforced] Per-IP rate-limit + lockout** — 10 failures within a 5-min window → 5-min
  lockout (429); never logs the token. (`auth.ts:78-112`)
- **[real-enforced] Same-origin web proxy** — `web/app/proxy/[...path]/route.ts` forwards browser
  calls to the API and injects the bearer from a server-only env var (never `NEXT_PUBLIC_*`), so the
  token never reaches the browser and the cross-origin CORS surface is removed. `redirect:"manual"`
  so redirects aren't followed across the proxy boundary.
- **[real-enforced] AES-256-GCM secret store at rest** (see §10).
- **[partial] Secret-store key custody** — the AES key sits in plaintext hex beside the ciphertext
  in the same data dir (protects against backup/snapshot leakage only); no KMS/Vault. Honestly
  documented.

## 13. SSRF Guard — `src/core/plugins/ssrf-guard.ts` (NEW SUBSYSTEM)
The prior scan called SSRF protection "hostname-regex-only and bypassable." **Now rewritten as a
real DNS-resolving guard and wired into every outbound HTTP path.**

- **[real-enforced] DNS-resolving SSRF guard** — `assertPublicUrl()` resolves the host with
  `node:dns` and rejects if ANY resolved address is private/loopback/link-local (incl. cloud-
  metadata `169.254.169.254`)/CGNAT/multicast/ULA-IPv6/link-local-IPv6/IPv4-mapped-IPv6 of a blocked
  range; literal IPs checked directly; non-http(s) schemes blocked; `localhost` blocked by name.
  (`ssrf-guard.ts`)
- **[real-enforced] Wired into all egress** — `http-get.ts`, `http-post.ts`, `notify-webhook.ts`,
  AND `extensions/yaml-capability.ts:488`. The previously-unguarded YAML path is now covered.
- Has a dedicated test suite (`ssrf-guard.test.ts`).

## 14. Marketplace — GitHub registry
- **[real-enforced] GitHub-repo plugin marketplace** — `github.com/sreenathmmenon/krelvan-registry`;
  the published `registry/index.json` holds **7** capabilities; the web Discover view reads it with a
  bundled seed fallback. Install is by-PR with a sha256 source-hash pin.
- **[aspirational] Marketplace economy** — `price` + `license-url` are string fields; there is no
  payment, escrow, entitlement enforcement, publisher signing, or provenance.

---

# SECTION 2 — WHERE IT'S GOING (ROADMAP)

Sourced from `docs/AUTH_PLAN.md`, `docs/MASTER_PLAN.md`, and the 9-expert `docs/PLUGIN_COUNCIL.md`
verdict (unanimous "pilot-only, fund the architecture"). Framed honestly: built vs planned.

1. **Auth Phase 2 — accounts, login & teams (planned).** Phase 1 (the bearer token + same-origin
   proxy + loopback-by-default) is **built**. Next is real human accounts: email+password
   (argon2id), httpOnly+SameSite session cookie + CSRF for the browser, Owner→Admin→Member roles,
   scoped revocable Personal Access Tokens, and invite-link team management (SMTP-optional). The
   design adopts **Better Auth** rather than hand-rolling crypto, and gates first-run account
   creation to loopback + the bootstrap token to avoid the nginx-ui/n8n "claim-window" takeover hole.

2. **Auth Phase 3 — RBAC separation-of-duties + SSO + multi-tenant (planned).** Distinct roles for
   *install-plugin* vs *approve-spend* vs *rotate-keys* (so the approval gate isn't theater);
   OIDC/SAML SSO; per-tenant principals replacing the hardcoded `owner-demo`. This is the same build
   as multi-tenancy (per-tenant token/secret/ledger namespaces) — done once.

3. **Real plugin sandbox — worker → microVM (planned).** Replace `worker_threads` (crash/state
   isolation only) with a per-plugin OS process or microVM (Firecracker/gVisor), cgroup CPU/mem
   limits, an fs jail, and an **egress proxy that is the only network path** — turning the capability
   allowlist into a network-layer fact. The council's #1 production blocker.

4. **Measured cost / metering (planned).** Route plugin egress through a metering proxy so
   cost/tokens/bytes are *observed*, not self-claimed — making the supervisor co-sign a genuine
   measurement and the budget ceilings truly enforceable. (Today: declared/estimate enforcement is
   real; settled cost trusts the plugin.)

5. **Asymmetric / non-repudiable signing (planned).** Swap HMAC for Ed25519 with a KMS/HSM-anchored
   key and ship a third-party verification CLI — moving from internal tamper-evidence to externally
   provable, court-defensible audit. The Signer port already abstracts this, so it's an adapter swap.

6. **Marketplace publisher economy (planned).** Publisher identity + signature verified at install
   (SLSA/sigstore-style provenance), a "verified publisher" tier, and payment/entitlement rails on
   top of the existing `price`/`license-url` fields.

7. **Persistence & ops hardening (planned).** Postgres adapter + RLS for multi-tenant isolation;
   atomic writes for the capability/schedule registries; mid-run crash reconciliation; backup/
   restore/DR runbook. The port-and-adapter discipline means these are adapters, not rewrites.

8. **Tail-truncation checkpoint, notarized clock, KMS/Vault secret backends (planned).** Finish the
   ledger trust-root items: signed checkpoints (LED-07), a trusted notarized `now` for validity
   windows, and pluggable secret backends behind the existing SecretBroker port.

---

# SECTION 3 — RESUME ENTRY (ready to paste)

*Product/feature/vision focus. No LoC or test counts. First-build verbs only (Built / Designed /
Created — never "re-architected"). Every claim is code-verified. Krelvan is in active development.*

## ⭐ RECOMMENDED — The Blend (best headline + strongest bullets)

**Krelvan — Own Your AI Agents** *(in active development)* · TypeScript · Next.js · Event-Sourced Runtime · Signed Ledger · MCP · 7 LLM Providers
- Built a self-hostable platform where you describe an outcome in plain English and get a real, running multi-agent system you fully own — no cloud, no vendor lock-in, your data stays yours.
- Made the signed, append-only event ledger *the runtime itself* — so what you see is exactly what executed, and an agent can crash mid-run and resume with no action ever repeated.
- Designed a natural-language-to-agent compiler that treats the LLM's output as untrusted data — so a prompt-injected instruction can only *shrink* an agent's powers, never expand them — paired with deny-by-default controls so an agent can never silently spend money or do something irreversible without your approval.
- Created a GitHub-based marketplace of installable capabilities — connect Slack, search the web, deploy to Vercel in one click — so anyone can build and ship agentic solutions on top.

---

## Version 1 — Own your agents
**Krelvan — Own Your AI Agents** *(in active development)* · TypeScript · Next.js · Event-Sourced Runtime · MCP · 7 LLM Providers
- Built a self-hostable platform where you describe an outcome in plain English and get a real, running multi-agent system you fully own — no cloud, no vendor lock-in, your data stays yours.
- Made the signed event ledger *the runtime itself* — every action an agent takes is recorded, verifiable, and replayable, so what you see is exactly what executed.
- Designed a trust ladder where agents earn autonomy (suggest → approve → autonomous), with deny-by-default controls so an agent can never silently spend money or exceed what you allowed.
- Created a GitHub-based marketplace of installable capabilities — connect Slack, search the web, deploy to Vercel in one click — so anyone can build and ship agentic solutions on top.

## Version 2 — Trust you can prove
**Krelvan — The AI-Agent Platform Where Trust Is Provable** *(in active development)* · TypeScript · Signed Ledger · NL→Manifest Compiler · MCP
- Set out to answer the hardest question in agentic AI — *can you trust what an autonomous agent does?* — by making every action signed, gated, reversible, and impossible to silently escalate.
- Designed a natural-language-to-agent compiler that treats the LLM's output as untrusted data, so a prompt-injected instruction can only *shrink* an agent's powers, never expand them — closing the door on prompt-injection privilege escalation by design.
- Built side-effect-aware execution that classifies every action — read, write, spend, message a human — and pauses for approval before anything irreversible, so an agent literally cannot wire money or delete data without your go-ahead.
- Shipped it as a full self-hosted product: a visual canvas where the graph you watch *is* the graph that runs, a tamper-evident audit timeline, and agents that diagnose their own failures and rebuild a corrected version automatically.

## Version 3 — A platform to build on
**Krelvan — A plugin CMS-Style Platform for AI Agents** *(in active development)* · TypeScript · Next.js · Plugin Marketplace · MCP · Self-Hosted
- Building the open layer for agentic AI: download it, self-host it, extend it with plugins, and build & sell agentic solutions on top — the way plugin CMS opened up the web.
- Created a natural-language builder that turns a goal into a running, signed agent in seconds, paired with a GitHub-based marketplace where the community publishes installable capabilities.
- Made any MCP server instantly usable — connect one and every tool it exposes becomes a governed capability, under the same approval gates and signed audit trail as everything else.
- Designed for the people who build *for* others: agencies and dev shops can self-host per client and hand over a cryptographically-signed record of everything their agents did.

## Version 4 — Describe it, watch it, trust it
**Krelvan — Describe an Outcome, Get an Agent You Can Trust** *(in active development)* · TypeScript · Next.js · Event-Sourced · 7 LLM Providers
- Built a self-hosted platform where you type what you want, watch the agent graph compile live on a visual canvas, run it, and open a signed, replayable record of every step it took.
- Made agents model-agnostic by design — each one is a portable, declarative manifest that names no model, so you can swap between 7 LLM providers (Anthropic, OpenAI, Gemini, Groq, Mistral, Ollama, or any compatible) with a single setting.
- Wired in real capabilities, not demos: agents fetch live data, reason, compose, notify Slack and Discord, and deploy apps to Vercel, Netlify, and Cloudflare — each action budget-bounded and approval-gated.
- Gave agents the ability to reason about their own failures — when a run breaks, Krelvan reads its signed history, explains *why*, and rebuilds a corrected agent on its own.

## Version 5 — The ledger is the runtime
**Krelvan — Where the Ledger *Is* the Runtime** *(in active development)* · TypeScript · Event-Sourced Kernel · Signed Append-Only Log · MCP
- Built an AI-agent platform from first principles around one idea: a signed, append-only event log isn't just the audit trail — it *is* the execution engine, and the canvas, memory, and history are all live views of it.
- This makes replay, resume, and undo exact and free — an agent can crash mid-run and resume with no action ever repeated, because all of its state lives in the ledger.
- Layered a deny-by-default capability system with budget limits and human-in-the-loop approval on top, plus a natural-language compiler with built-in defense against prompt-injection privilege escalation.
- Delivered the whole thing as a complete, self-hostable product — visual builder, live run-trace, plugin marketplace, MCP support, secure-by-default — with a core that has zero third-party dependencies.

## Version 6 — The agent you can audit
**Krelvan — Every Agent Action, Signed and Replayable** *(in active development)* · TypeScript · Next.js · Event-Sourced · MCP · Self-Hosted
- Built a self-hosted AI-agent platform around a question most agent tools ignore: *when an agent acts on your systems, can you prove exactly what it did?*
- Made every step an agent takes signed and tamper-evident, so you can scrub a run backward, replay it, and hand someone a verifiable record — not a vendor's word — of what happened.
- Designed agents to ask before they act on anything risky — spending, sending, or anything irreversible pauses for human approval, with the rules enforced by the system, not the prompt.
- Turned natural language into a running agent in seconds, extensible through a GitHub-based plugin marketplace and any MCP server, so it grows with whatever tools you connect.

---

*Which to pick: The Blend or V1 for a recruiter skim; V2 or V6 for trust/security/fintech/enterprise
roles; V5 for AI-platform/infra roles; V3 for startups/founders. All are honest to what's built —
deliberately NOT claimed: sandboxed untrusted code, enterprise multi-tenant, non-repudiable signing,
or measured-cost enforcement (those are on the roadmap, Section 2).*
