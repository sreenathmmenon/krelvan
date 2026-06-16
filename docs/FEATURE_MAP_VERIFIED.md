# Krelvan — Code-Verified Feature Map

*Produced by a 10-agent code-scan fleet that read every source file line-by-line (180 file reads). This is ground truth from the CODE, not the docs.*

This is a synthesis task — consolidate the six subsystem audits into one ground-truth feature map. No tools needed; the evidence is all provided. Here is the consolidated map.

---

# KRELVAN — CODE-VERIFIED FEATURE MAP

Status legend: **[real-enforced]** code does what it claims + wired into live paths (often tested) · **[real-partial]** works but with a material caveat/gap · **[stub]** standalone/unwired/toy or contradicted by code · **[doc-only]** claim exists in comments/UI with no implementing code on the live path.

---

## 1. Ledger & Cryptographic Core (`src/core/ledger`)
The strongest subsystem. Single-tenant tamper-evidence is genuinely real.

- **[real-enforced] Content-addressing over full preimage** — id hashes type/scope/parents/prev/offset/payload/determinism/ts/author, not just payload; re-parenting or repositioning changes the id (LED-03).
- **[real-enforced] Canonical serialization** — deterministic key sort, undefined omission, idempotent; rejects non-plain prototypes (LED-01).
- **[real-enforced] Numeric safety** — throws on float/NaN/Infinity/bigint/unsafe-int; forces money/counts to integers (LED-02). *(But see kernel §2 float-output gap.)*
- **[real-enforced] SHA-256 addressing**, algo-tagged `sha256:<hex>`.
- **[real-enforced] HMAC-SHA256 signing over the content address (id), not the object** (LED-09).
- **[real-enforced] Hash-chain linkage + contiguous offsets** assigned inside the append lock; verify catches gap/dup/broken-chain (I3/I4/LED-06).
- **[real-enforced] Tamper-evidence via id recomputation** in `verify()` and on-disk `selfCheck()` (I1) — mutate any stored field → HashMismatch/BrokenChain/OffsetGap/BadSignature.
- **[real-enforced] Author == signer == sig keyId** (I6); **dangling-parent rejection** (I5); **determinism tag** (only EffectResult may be `captured`, I7).
- **[real-enforced] Atomic CAS append, no forks** — in-memory per-tenant mutex; SQLite `BEGIN IMMEDIATE` + `PRIMARY KEY(tenant,offset)`; 50-way concurrent test passes.
- **[real-enforced] On-disk durability + restart recovery** — SQLite WAL + synchronous=FULL; survives close/reopen. *(Caveat: `node:sqlite` is experimental on Node 22; no independent fsync/torn-write check.)*
- **[real-enforced] Typed Result error model** — no silent failures; any verify failure surfaces as UNVERIFIABLE.
- **[real-partial] Key validity windows / rotation** — epoch + validFrom/validUntil enforced; but validity is resolved from **signer-supplied `sig.signedAt`**, not a trusted clock → a revoked-secret holder can backdate inside the old window (ties to §6 backdating).
- **[real-partial] HMAC is offline single-owner only** — verifier holds the same secret it verifies, so tamper-evidence vs outsiders but **no non-repudiation**; asymmetric/hardware trust root is comment-only.
- **[real-partial] timingSafeEqualHex** — hand-rolled constant-time compare, not `crypto.timingSafeEqual`; early-returns on length mismatch.
- **[stub] Tail-truncation detection via signed checkpoint (LED-07)** — `checkpoint.ts` (cited in event.ts:12) **does not exist**; no production code builds/signs/passes a Checkpoint; every real `verify()` caller omits it; even when supplied it never binds headHash/count so a forked equal-length tail passes. Only the unit test exercises it.
- **[doc-only] Hash-algo agility (LED-04)** — `HASH_ALGO` hardcoded sha256; `parseContentAddress` has zero callers; verify never reads the tag.
- **[doc-only] NFC unicode normalization "enforced at the event boundary"** — no `normalize()`/NFC call anywhere; distinct unicode forms hash to different ids.
- **[doc-only] "Validity resolved at a trusted notarized now"** — `verify()` has no `now` param.

---

## 2. Kernel & Engine (`src/core/kernel`)
Deterministic decide() + event-sourced engine. Load-bearing crash-safety claims hold.

- **[real-enforced] `decide()` purity** — no I/O/clock/randomness; restricted expr evaluator, never `eval`; sole decision authority.
- **[real-enforced] 3-event effect protocol** (AdmissionDecision → EffectRequested → EffectResult) with **correct signer separation**: orchestration owner-signed, EffectResult **supervisor-signed**, plugins never sign; pluginClaim carried as untrusted data.
- **[real-enforced] Projection/fold** — single `applyEvent` transition shared by `project()` and the incremental folder; tracks visits/budget/awaits/results; scalar-only state (arrays/objects silently dropped).
- **[real-enforced] Incremental fold** — checkpointed hot path with safe fallback (open reservations / log shrink / no checkpoint); deep-copies to avoid aliasing.
- **[real-enforced] Crash-resume / no double-execution** — all state in the ledger; RE-SERVE skips any idem already in resultsByIdem; idempotency key = hash(nodeId, capability) only. Proven across two engine "lives" for both effects and sub-agents.
- **[real-enforced] Reserve-then-settle budget gating** — denies if projected run/per-cap spend exceeds ceiling (counts reserved); negative cost clamped; single RunFailed on deny.
- **[real-enforced] Approval park / autonomy gradient (HITL)** — appends AwaitRequested *before* any admission/reservation, parks with no budget footprint; resume via AwaitResolved.
- **[real-enforced] Sub-agent path (agent-as-capability)** — deterministic subRunId, separate ledger, budget capped to reservation, output mapping, monotone authority; idempotent re-serve proven (child runs exactly once across restart).
- **[real-enforced] Signing authority separation** — append throws on store rejection; plugins never sign.
- **[real-partial] Crash-hole HALT** — `crashHoles()` (EffectRequested w/o EffectResult) forces halt-first in decide(); correct, but **no unit test** exercises the hole path (the crash test crashes *after* a clean NodeConcluded).
- **[real-partial] Loop bound (maxNodeVisits)** — **OFF-BY-ONE**: check fires while node is entered with visits already incremented, so `maxNodeVisits:1` fails on the first visit before the body runs; min usable value is 2. The kernel comment is wrong. All tests use 5, so untested.
- **[real-partial] Float-output sanitization** — `sanitizeOutput` guards EffectResult/SubRunCompleted, but **NodeConcluded state is built from un-sanitized output** → a float scalar (e.g. `price:227.52`) crashes the run via CanonicalError. The "fixes stock prices like 227.52" comment is only half true.
- **[stub] `validateSubAgentBinding`** — self-described best-effort; never verifies referenced sub-keys exist and is **never called** in the execution path despite docs claiming "validated at admission time."
- **[stub] Engine `case 'conclude'`** — dead code; `decide()` never returns `{kind:'conclude'}`.
- **[doc-only] `EffectCall.input` comment** claims the idempotency key derives from input; the code deliberately excludes input (code is correct, doc misleads).

---

## 3. Capability Plane — admission & supervisor (`src/core/capability`, `extensions/yaml-capability.ts`, `directory-loader.ts`)
**The pure in-kernel decisions are real and trustworthy. Every impure egress/cost/secret/isolation boundary is aspirational.**

- **[real-enforced] Deny-by-default admission** — capability must be explicitly declared in the node manifest; no fall-through; null estimate (plugin absent/disabled) → CAPABILITY_NOT_GRANTED.
- **[real-enforced] Run-level + per-node-cap budget ceilings** — reserve-then-settle, counts open reservations so concurrent calls can't jointly overflow.
- **[real-enforced] Negative-cost clamp** — `Math.max(0, costCents)` prevents a plugin driving spend negative.
- **[real-enforced] Side-effect taxonomy + `needsApproval` gradient** — whitelist-validated; read=never gates, suggest=gates all, act-with-veto=gates only write-irreversible/spend/identity-mutation, full=never gates. **Genuinely wired to the engine's AwaitRequested park.**
- **[real-enforced] Plugin never self-signs EffectResult** — supervisor (distinct key) signs; plugin claim kept as separate untrusted data.
- **[real-enforced] No-eval whitelist interpolation** — only `{{secret:name}}` / `{{input.field}}`; safe dot-paths; no Function/eval/prototype access.
- **[real-enforced] Integer-cents validation** + **handle-gated atomic snapshot swap** (holding a Supervisor can't poison the registry).
- **[real-enforced] Directory auto-loader** — scans `capabilities/` for mcp-servers.json / .yaml / .js-.ts; per-file error isolation.
- **[real-partial] YAML capability HTTP execution** — real `fetch()`, successCodes check, responseField extraction; but `claimedCostCents` is hardcoded to `estimateCents` (no cost ever measured).
- **[real-partial] YAML interpolation injection** — `{{input.field}}` inserted raw via `String(val)` into URL/headers (CRLF header injection possible; URL compounds the SSRF gap); body is JSON-contained.
- **[real-partial] successCodes/responseField/type validation** — structural only; **declared output fields are never validated against the actual response** (admitted "not enforced at runtime").
- **[real-partial] Custom YAML parser** — restricted; silently drops over-indented lines and coerces numeric-looking scalars (malformed nesting lost, not errored).
- **[stub] Supervisor "co-signs MEASURED cost"** — **no egress metering / token counting / sandbox measurement**; supervisor just rounds and re-labels the plugin's self-claim. Comments concede real enforcement is future work.
- **[stub] YAML SSRF protection** — **NONE** on the advertised zero-code path; load-time check only validates URL prefix and permits `http://` + `{{input.*}}` host substitution → SSRF to 169.254.169.254/localhost/RFC1918. (Hand-written plugins have a guard; YAML bypasses it.)
- **[stub] Arbitrary JS/TS capability execution** — `loadJsCapabilities` does bare `await import()` of any dropped `.js/.ts/.mjs` **in-process with full host privileges**; comment claims a worker thread (false here), CLAUDE.md claims Modal sandbox (not applied).
- **[doc-only] "Broker mints scoped tokens / plugin never holds raw secrets"** — false on the live path: raw secret strings from SecretStore/`process.env` are interpolated directly into outgoing requests; no broker/minting/scoping/TTL.

---

## 4. Plugin Lifecycle & Loaders (`src/core/plugins/*`, `src/infrastructure/plugins/*`)
Lifecycle integrity (atomicity, hash-pinning, state machine) is genuinely strong. Isolation and secret delivery are not.

- **[real-enforced] `install()`** — path containment (absolute-resolve inside pluginsRoot), existsSync, sha256 hash, dry-load to discover self-declared name, name regex, dedup; persists "installed" without loading.
- **[real-enforced] `enable()` / `disable()` / `uninstall()`** — hash-pinning re-check (SOURCE_CHANGED), MISSING_SECRETS preflight, atomic registry-row + ledger-event in one `BEGIN IMMEDIATE`, then snapshot pointer-swap, then teardown. Uninstall has a **pending-commitments guard** (open EffectRequested w/o EffectResult across all tenants → blocked).
- **[real-enforced] Atomic registry+ledger writes** on a shared DatabaseSync; commit-first / swap-second / teardown-last ordering means a crash never puts the supervisor ahead of the ledger.
- **[real-enforced] Startup re-activation** (`PluginActivator.loadAll`) re-hashes every enabled plugin; failure → disabled + PluginLoadFailed (one bad plugin can't block boot).
- **[real-enforced] Source-hash pinning** end-to-end (install/enable/startup); recorded into every lifecycle event payload.
- **[real-enforced] DelegatePlugin (sub-agent delegation)** — monotone budget narrowing (`Math.min`, same principal), fresh isolated engine, supervisor co-signs sub-run results.
- **[real-enforced] Worker teardown / in-flight rejection** — terminates worker, rejects pending calls, post-teardown invoke throws.
- **[real-enforced] SqlitePluginRepository** — flat-column registry, UPSERT, corruption guards, hard-delete on uninstall.
- **[real-partial] TS worker isolation** — one long-lived Worker per enable (header comment "terminated after each invoke" is **false**); thread + module-cache + wall-clock-timeout isolation only.
- **[real-partial] Delegation HITL** — DelegatePlugin hardcodes `approve:()=>true`, **auto-approving every gated effect in the sub-run** even when the parent policy is suggest/act-with-veto. Authority/budget capped; the approval gate is not.
- **[real-partial] OwnerId branding** — `parseOwnerId` validates, but lifecycle methods trust the branded type and never re-validate.
- **[stub] Worker resource/network/fs sandbox** — **no resourceLimits, no Node permission flags**; a malicious TS plugin keeps full ambient `fetch`/`fs`/`child_process`/`process.env`. (Same class of gap as §3 in-process JS exec.)
- **[stub] TS-plugin secret delivery** — **broken end-to-end**: worker handler destructures only `{id,call}` and ignores `msg.secrets`; combined with install persisting TS `secretRefs=[]`, secrets never reach a TS plugin.
- **[real-partial] `install()` secretRef extraction** — only populated in the dry-load **failure** branch, so well-formed YAML and all TS plugins persist `secretRefs=[]` → `enable()`'s MISSING_SECRETS preflight is silently skipped (YAML still resolves lazily at invoke; TS cannot).
- **Note:** WorkerBackedPlugin and DelegatePlugin both return `estimateCents=0`, so pre-dispatch reservation for them is nil — overspend protection relies entirely on settled cost / manifest cap.

---

## 5. Built-in Capabilities (`src/core/plugins/`)
All twelve make **real** external calls / disk I/O — none are mocks. The SSRF and cost-observation guarantees are weaker than the docstrings imply.

- **[real-enforced] `think` / `compose` / `llm_route`** — real LLM calls, token-based costing; `llm_route` **clamps the model's choice to declared candidates** (can't invent a node).
- **[real-enforced] `telegram_send` / `slack_send`** — real Bot API / Incoming Webhook POSTs, graceful failure.
- **[real-enforced] `recall` / `identify`** — real atomic JSON-file persistence; `identify` correctly classified `identity-mutation`.
- **[real-enforced] `text_transform`** — pure inline transform (defined in runtime.ts).
- **[real-partial] `web_search`** — Brave path is real; **LLM-fallback path returns model recall (`synthetic:true`, empty url) labeled as a search result** — not a web search. Brave path throws (non-graceful) on non-ok.
- **[real-partial] `http_get` / `http_post` / `notify_webhook`** — real fetch with timeouts, byte caps, HMAC signing (notify_webhook); but the **SSRF guard is hostname-regex-only** (see Reality Check).
- **[real-partial] `email_send`** — real Resend + hand-rolled ESMTP; **SMTP path is plaintext over `node:net` with no TLS/STARTTLS** on default port 587 → credentials sent in clear.
- **[real-partial] `remember`** — real disk write, but **declared `sideEffect:'read'` while writing files** → autonomy gate never requires approval. `http_get` is likewise labeled `read` despite network egress.
- **[stub] Supervisor cost "observation"** — accepts the plugin's self-reported `claimedCostCents` (rounded), no independent measurement (same as §3).
- **[real-partial] Secret broker for built-ins** — built-ins read credentials straight from `process.env`, bypass the SecretBrokerPort entirely (broker governs only installed file plugins); telegram token interpolated directly into the request URL.

---

## 6. Identity / Secrets / Time / MCP / Channels / Observability (`src/core/{identity,mcp,channels,observability}`)
Strongest real pieces: the time-window key lifecycle and the MCP client. Most headline security narratives here are **standalone unwired modules**.

- **[real-enforced] Key lifecycle (issue/rotate/revoke)** — windowed verify; out-of-window → typed reason; history stays verifiable.
- **[real-enforced] MonotonicClock** — never goes backward; signed-tick verifies. *(Standalone unit.)*
- **[real-enforced] MCP client** — JSON-RPC over stdio/HTTP, tool discovery, tool→CapabilityPlugin mapping; **actually wired into runtime**.
- **[real-enforced] Observability pure folds** — canvasView / costView / timelineView; **tamper-detecting `verificationReplay`** (flip a payload → UNVERIFIABLE); span tracer (used by the engine); structured logger.
- **[real-partial] Revocation** — closes the window but does **not** kill already-emitted in-window signatures (no revocation list); backdating beats it (ties to §1).
- **[real-partial] MCP transport** — stdio `request()` has **no timeout** (hangs forever on no reply); HttpMcpTransport hardcodes JSON-RPC `id:1` (no correlation), no auth headers.
- **[real-partial] InteractionResolver** — single-use/branch/principal/assurance checks are real and tested, **but** it's an in-memory Map, returns only an "authorized" tag (no grant minting despite the claim), trusts self-attested `assurance`, and is **imported only by its own test**.
- **[real-partial] `verificationReplay` "reconciliation"** — just re-sums the same log's recorded costs; **not** a cross-source reconciliation.
- **[real-partial] `planCounterfactual`** — honest that it executes nothing, but **never calls the admission gate**; "downstream" is by event order not graph topology; reuses historical costs.
- **[real-partial] Observability tracer OTEL** — span tracer real, but **no OTEL exporter exists**; only sink is the logger.
- **[stub] `SecretBroker` (identity.ts)** — mints a plain `tok_<dest>_<counter>` string with **no crypto binding to the secret and no redemption path**; a toy, and **not** the broker the runtime uses.
- **[stub] MCP side-effect inference** — **FAILS OPEN to `read`** (least restrictive) for any unrecognized tool — opposite of its own header; `wipeAccount`/`execSql` infer `read`.
- **[stub] "Approval IS authorization, mints the grant atomically"** — no grant minting; resolver unwired.
- **[stub] Observability user surface** — `observe.ts` imported only by tests; **no API route or web page** exposes audit timeline / cost meter / replay modes. *(Contradicts §7's UI claims partially — the UI builds its own folds from raw events, not observe.ts.)*
- **[doc-only] "Date.now() banned in core / time enters only as signed ticks"** — violated: live engine clock is raw `Date.now()`; `spans.ts` and `memory-plugins.ts` call `Date.now()` directly; MonotonicClock is never used in production.
- **Unwired-module cluster:** IdentityManager, identity.ts SecretBroker, MonotonicClock, InteractionResolver — **all four have zero production wiring** (imported only by their own tests).
- **Minor:** `canvasView` declares a `failed` status that's never produced (failed nodes show as running/done); logger declares `debug` level but exposes no `debug()` method.

---

## 7. API Server, Runtime & Adapters (`src/api/*`, `src/adapters/*`)
The live runtime. Most user-facing features are real; the **security posture is the biggest gap in the whole product**.

- **[real-enforced] HTTP API server + router** — node:http, ~40 routes, hand-rolled multipart upload, top-level error→500.
- **[real-enforced] SecretStore (AES-256-GCM at rest)** — per-value IV + auth tag, masked list, env fallback, tests pass.
- **[real-enforced] 7-provider LLM client** — Anthropic / OpenAI-compat (openai/groq/mistral) / Ollama / Gemini, distinct and provider-correct; unknown → Anthropic fallback.
- **[real-enforced] HTTP retry with backoff** — retryable status set, full-jitter, Retry-After, per-attempt timeout.
- **[real-enforced] AnthropicModel compiler adapter** — treats LLM output as untrusted **data**; compiler validates+signs.
- **[real-enforced] Builder self-correction loop** — up to 3× recompile with error-feedback folded into a separate augmented intent (clean intent never pollutes stored provenance).
- **[real-enforced] Diagnose / retry-with-fix / explain / explain-build** — real LLM reasoning grounded in the signed ledger; retry produces a **genuinely rebuilt** corrected agent, not a replay.
- **[real-enforced] Run execution + SSE streaming** — fire-and-forget executeRun; SSE polls the ledger every 400ms with heartbeats.
- **[real-enforced] HITL approvals** — pairs AwaitRequested/AwaitResolved across halted runs; double-resolve race guard (covers the append window only).
- **[real-enforced] Scheduler** — zero-dep cron parser + interval, persisted, re-arms on boot (single-process, no leader coordination).
- **[real-enforced] Capability/plugin lifecycle wiring, secret resolution, MCP connect/disconnect, agent memory read/clear, model registry, stub model port** (no-LLM fallback produces a trivial compose agent).
- **[doc-only] NO authentication / authorization on ANY route** — every destructive endpoint (delete agents, set/delete secrets, **upload+enable arbitrary TS/JS plugins = arbitrary code execution**, connect MCP via shell `command`, resolve approvals) is open to anyone who can reach the port. Only the "self-hosted/single-tenant" docstring stands in for security.
- **[real-enforced but single-tenant] Hardcoded tenant/principal** — tenant is literally `'default'`, principal `'owner-demo'`/`'owner-import'`; fixed 10,000-cent ceilings; **no multi-tenant isolation exists.**
- **[real-partial] Hardcoded HMAC ledger signing secrets** — `'krelvan-owner-secret'`/`'krelvan-sup-secret'` baked in source with `validUntil:null`. The ledger's tamper-evidence is **only as strong as a repo constant**, and this violates the project's own "never hardcode secrets" rule.
- **[real-partial] SecretStore key custody** — AES key sits in **plaintext hex beside the ciphertext** in the same data dir; protects against backup/snapshot leakage only, not an attacker with the data dir (code admits this).
- **[real-partial] LLM cost estimation** — curated prefix→rate table; **returns 0 for ollama/groq/mistral/compatible/any unmatched model**, so budget enforcement is effectively absent on those providers. Tables include speculative ids (`claude-opus-4-8`, `claude-fable-5`).
- **[real-partial] Persistence** — agents/runs use atomic tmp+rename; **CapabilityRegistry.persist and ScheduleRegistry.persist use plain non-atomic writeFileSync** (crash mid-write can corrupt). Runs are fire-and-forget in-memory — **a crash mid-run leaves a run stuck in `running` with no restart reconciliation.**
- **[stub] AnthropicDistiller** — fully implemented + tested but **never instantiated by the runtime**; still reads legacy `GENESIS_*` env vars.
- **Minor:** SSE polls per-connection (O(connections×events) DB reads); diagnose/explain duplicate a hardcoded fallback model literal; inconsistent active-run concurrency policy (start doesn't block, delete/clear do).

---

## 8. Web UI (`genesis-new/web`)
Real Next.js client; every endpoint it calls maps to a concrete server handler — **nothing is mocked**.

- **[real-enforced] NL builder + build-preview modal, dashboard, run trace (Output/Graph/Timeline/State/Explain) with SSE + polling fallback, auto-explain/diagnose/retry-with-fix, interactive canvas (pan/zoom/scrub/blueprint-live/heat-map), approvals inbox, capabilities install/enable/disable/remove/view+edit source, MCP connect/disconnect, secrets set/delete (server-derived "required" list), schedules CRUD, runs list.**
- **[real-enforced] Autonomy simulator honesty** — the UI's `needsApproval()` (sideEffects.ts) is **byte-for-byte the engine's** `needsApproval()` (capability.ts), so the capabilities approval simulator is accurate.
- **[real-partial] Marketplace Discover** — remote GitHub `index.json` with `cache:no-store`, falls back to ~16-entry bundled seed; the remote-vs-bundled source flag is computed but **never shown** to the user.
- **[real-partial] Verified/HMAC "Signed" badges** — **presentational only**; the UI never verifies a signature client-side, it displays the event count and trusts the backend.
- **[real-partial] ⌘K command palette** — navigation-only over **8 static commands**; cannot search agents/runs/live data.
- **[stub] Approval risk labels (low/med/high)** — hardcoded frontend `CAP_RISK` map **decoupled from the engine's side-effect class**; unknown caps always render "MEDIUM / External action," which can disagree with the gate that actually fired.
- **[stub] HeroAnimation** — fabricated ledger hashes + "VERIFIED" seal; marketing-only, shown only until a real run exists (then swaps to the real signed run).
- **[doc-only] Build-stage progress labels** — timed cosmetic strings, not streamed pipeline events.
- **[doc-only] Self-host install command + GitHub links** — static marketing strings.
- **Not audited:** NavClient, agents/[id], MemoryTab — agent-detail and memory surfaces unverified.

---

# VERIFIED REALITY CHECK

**Genuinely real (load-bearing, code + tests + live wiring):**
1. **Single-tenant ledger tamper-evidence is real.** Mutate any stored field and `verify()`/`selfCheck()` catch it (HashMismatch/BrokenChain/OffsetGap/BadSignature). Content address covers the full preimage incl. position and scope. (Ledger §1)
2. **Crash-safety / no-double-execution is real and proven across two engine "lives"** — for both effects and sub-agents — via ledger-folded state + deterministic (nodeId,capability) RE-SERVE. (Kernel §2)
3. **Reserve-then-settle budget gating is real and concurrency-safe** (counts open reservations, clamps negative costs). (Kernel §2 / Capability §3)
4. **Deny-by-default admission + the needsApproval autonomy gradient are real and actually wired to a HITL park** in the engine. The web simulator mirrors engine code byte-for-byte. (Capability §3 / UI §8)
5. **Signer separation is real** — supervisor signs EffectResult, plugins never sign; owner signs orchestration. (Kernel §2 / Capability §3)
6. **Capability monotonicity (the security core of the compiler) is real and tested** — an untrusted principal cannot add caps, raise budgets, or smuggle a spend under a read name. (Compiler — §ref in source audits)
7. **Manifest signing binds provenance into the signature** (swapping principal/intent invalidates it). Safe-expr typed AST has genuinely **no eval/Function** anywhere. (Compiler)
8. **Plugin lifecycle is atomic and hash-pinned** — registry-row + ledger-event in one transaction, source-hash re-verified on enable and every boot, uninstall blocked on pending commitments. (Lifecycle §4)
9. **All built-in capabilities make real calls** (LLM/Brave/HTTP/SMTP/Telegram/Slack/disk) — none are mocks. (§5)
10. **The web UI is fully wired to a real API** — nothing mocked; SSE streaming, diagnose, retry-with-fix, canvas replay all read real ledger data. (§7/§8)

**Claimed but NOT real (do not represent these as working):**
1. **No authentication/authorization anywhere.** Every destructive endpoint — including **arbitrary code execution via plugin upload+enable** and MCP shell-`command` connect — is open to anyone who can reach the port. This is the single biggest gap. (§7)
2. **No code isolation/sandbox.** TS plugins run in a thread with **full ambient fs/net/child_process/env**; YAML's JS path `import()`s dropped files **in-process**. The claimed worker-sandbox/Modal isolation does not exist on these paths. (§3/§4)
3. **No cost is ever measured.** The "supervisor co-signs what it MECHANICALLY OBSERVED" narrative is cosmetic relabelling of the plugin's self-claim; YAML caps hardcode cost=estimate; non-Anthropic/OpenAI/Gemini providers cost 0. Budget enforcement trusts plugin-reported numbers. (§3/§5/§7)
4. **Secret-broker / scoped-token / "plugin never holds raw secrets" is false on the live path.** Raw secrets are interpolated straight into requests; the real broker is a different inline object; the identity.ts token broker is an unusable toy. **TS-plugin secret delivery is broken end-to-end.** (§3/§4/§6)
5. **SSRF protection is hostname-regex-only and bypassable** — no DNS resolution (public host → 127.0.0.1/metadata passes), redirects re-followed without re-check, misses 169.254.0.0/16, IPv4-mapped IPv6, alt encodings. **The YAML zero-code path has no SSRF guard at all.** (§3/§5)
6. **Ledger trust root is weak.** HMAC secrets are hardcoded repo constants (so integrity = a constant in source), signing is symmetric (no non-repudiation), and validity windows are resolved from **signer-supplied `signedAt`** → a revoked-key holder can backdate and still verify. No asymmetric/hardware root, no real revocation kill. (§1/§6/§7)
7. **Tail-truncation protection (LED-07) is dead** — `checkpoint.ts` doesn't exist, no caller passes a checkpoint, and the check wouldn't bind headHash/count anyway. (§1)
8. **The "instruction-laundering" trust gate is dead code** — `consequentialFacts`/`isTrusted` have no caller outside tests; nothing filters untrusted facts before a consequential decision. (Memory)
9. **Memory is NOT a ledger projection in production** — the live runtime serves/clears memory from standalone `.semantic.json`/`.episodes.json` files; `projectMemory()` has zero non-test callers. (Memory)
10. **"Notarized time" is doc-only** — the live clock is raw `Date.now()`; the "Date.now banned in core" rule is violated in core; MonotonicClock is unwired. (§6)
11. **"Approval IS authorization / mints the grant atomically" and the whole InteractionResolver/IdentityManager/SecretBroker/MonotonicClock cluster are unwired** — implemented and unit-tested, but not on the live execution path. (§6)
12. **MCP side-effect inference fails OPEN to `read`** — an unrecognized destructive tool is treated as a harmless read. (§6)
13. **Several side-effect mislabels weaken the autonomy gate** — `remember` and `http_get` are `read` despite writing/egressing, so they never require approval. **Delegation auto-approves** every sub-run effect regardless of parent policy. (§4/§5)
14. **Observability replay/cost/audit views have no user surface**, `verificationReplay` "reconciliation" is a same-log re-sum (not cross-source), `planCounterfactual` never re-gates, and UI "Signed" badges verify nothing client-side. (§6/§8)
15. **Crash-resilience of the runtime is partial** — runs are fire-and-forget in memory; a mid-run process crash leaves a run stuck `running` with no reconciliation; capabilities.json/schedules.json writes are non-atomic. (§7)

**Net:** Krelvan's *pure, in-kernel, event-sourced core* — the ledger, the deterministic kernel, admission/budget/approval decisions, monotonicity, manifest signing, and crash-safe resume — is genuinely real and well-tested. Everything that depends on an *impure trust boundary* — authn/authz, code isolation, measured cost, secret scoping, SSRF, notarized time, non-repudiable signing, and the channel/identity/observability security narratives — is aspirational, stubbed, unwired, or contradicted by the live code.