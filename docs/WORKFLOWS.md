# Krelvan — Workflows (Live Site & Self-Hosted)

This document describes the real, code-verified workflows for the two ways Krelvan runs:
the **public live site (krelvan.com)** and a **self-hosted instance** a customer runs.
Every flow below is traced to the actual source (file:line), not assumed.

---

## 1. The two deployments

Krelvan is one codebase serving two roles, split by a session gate:

| | **Live site (krelvan.com)** | **Self-hosted instance** |
|---|---|---|
| Who runs it | You (the maintainer) | The customer, on their own machine/server |
| Admin account | Yours (single admin) | Theirs — created on their first run |
| Public visitors | Browse the marketplace/registry (read-only, no login) | n/a (private box) |
| Building/running agents | Behind the admin login (your workspace) | Behind their admin login (their workspace) |
| Network binding | Exposed (behind HTTPS) | `127.0.0.1` by default (`bin/krelvan.mjs`, `src/api/index.ts:54`) |

The **access boundary** is the same in both: a *public directory* anyone can browse, and a
*private workspace* that requires the single admin session.

---

## 2. Access model — public vs gated (both deployments)

Two independent gates enforce this:

- **Page gate** — `web/middleware.ts`. `PUBLIC_PATHS` are served to anyone; every other page
  redirects a logged-out browser to `/login` (which bounces to `/setup` on a fresh install).
- **API gate** — `web/app/proxy/[...path]/route.ts`. The browser never holds the API bearer
  token; it calls the same-origin `/proxy/api/*`. The proxy holds the server-only bearer
  (`KRELVAN_AUTH_TOKEN`) and injects it — BUT only forwards a call if a valid session cookie
  is present, except for the `PUBLIC_API` allowlist. No session → `401` (swallowed by the UI).

```
                         ┌─────────────────────── PUBLIC (no login) ───────────────────────┐
  Browser ──▶ Next page  │  /  /login  /setup  /faq   +  the marketplace catalog (rendered   │
             (middleware) │  from the PUBLIC Git registry, fetched client-side — no session)  │
                          └──────────────────────────────────────────────────────────────────┘
                         ┌─────────────────────── GATED (admin session) ──────────────────────┐
  Browser ──▶ Next page  │  /dashboard  /agents  /runs  /inbox  /approvals  /schedules          │
             (middleware) │  /secrets  /connections   +  install/enable/run/mutate anything      │
                          └──────────────────────────────────────────────────────────────────┘

  Browser ──▶ /proxy/api/* ──▶ [session cookie?] ──no──▶ 401 (UI swallows)
                               │
                               └─yes─▶ inject KRELVAN_AUTH_TOKEN bearer ──▶ API (127.0.0.1)
```

**Verified in code:**
- `web/middleware.ts:11` — `PUBLIC_PATHS`
- `web/app/proxy/[...path]/route.ts:23` — `PUBLIC_API` allowlist (`auth/status`, `auth/login`,
  `auth/logout`, `auth/setup`, `health`, `status`)
- `web/app/proxy/[...path]/route.ts:18` — `AUTH_TOKEN` server-only, injected by the proxy

**Why the marketplace can be public without leaking anything:** the catalog is fetched
client-side from a public URL (`web/lib/registry.ts:70` — the GitHub `index.json`), with a
bundled seed fallback. Its entries declare which secrets a connector *needs* (`{{secret:NAME}}`
placeholders) — never real credentials. Installing/enabling (which touches the private
instance) stays gated.

---

## 3. Live site (krelvan.com) — visitor workflow

```
 Visitor ──▶ krelvan.com (/)                    public marketing homepage
     │        - live "describe your agent" panel (preview; build needs login)
     │        - stats, pitch, links
     │
     ├──▶ Marketplace / Connectors              browse agents, MCP connectors, capabilities
     │      (public directory, no login)        rendered from the public Git registry
     │
     ├──▶ "Install / use it" CTA                → self-host: clone the repo & run your own
     │                                            (you don't log into the maintainer's box)
     │
     └──▶ GitHub / Docs links                   inspect the source, read the docs
```

A visitor **browses**; to actually **build & run** agents they self-host their own instance
(the plugin CMS.org model: public directory + your own install). The maintainer's admin
workspace on krelvan.com is not for public use.

---

## 4. Self-hosted — first-run & boot workflow

`npx krelvan` (from the cloned repo) runs `bin/krelvan.mjs`, which:

```
 npx krelvan
     │
     ├─ 1. Node ≥ 22 gate (fail clearly if older)          bin/krelvan.mjs
     ├─ 2. build core (tsc) → dist/           [first run]   bin/krelvan.mjs:163
     ├─ 3. install web deps + build web UI    [first run]   bin/krelvan.mjs:173,184  (~2-3 min)
     ├─ 4. derive ONE shared auth token (persisted)         bin/krelvan.mjs:245  launcher.token
     ├─ 5. start API   on 127.0.0.1:3201  (loopback)        src/api/index.ts:54
     └─ 6. start web   on 127.0.0.1:3100  (loopback)        bin/krelvan.mjs (KRELVAN_WEB_HOST)
                                                            → expose deliberately via env

 Open http://localhost:3100
     │
     ├─ No admin yet → /setup                               src/api/admin-auth.ts
     │     - the API printed a one-time SETUP TOKEN in the terminal (30-min TTL)
     │     - enter username + password + token → creates the ONE admin (scrypt)
     │
     └─ Admin exists → /login                               scrypt verify, constant-time,
           - username + password → session cookie           per-IP lockout, anti-enumeration
```

**Security posture (verified):**
- Loopback-by-default; exposing is a deliberate act (`KRELVAN_WEB_HOST` / `KRELVAN_HOST`);
  the API refuses to bind non-loopback without an auth token (`src/api/index.ts:97`).
- Setup token pattern (PocketBase model) closes the "first-run admin claim" CVE class.
- Secrets encrypted at rest, AES-256-GCM (`src/api/secret-store.ts`).

---

## 5. The core pipeline — describe → build → run → deliver (self-hosted, gated)

This is identical for a logged-in admin on either deployment.

```
 (A) BUILD                                             (B) RUN
 ─────────                                             ───────
 UI: type a goal in plain English
   │  POST /api/agents/build          server.ts:208
   ▼
 buildAgent(intent)                   runtime.ts
   │  Compiler.compile(intent, principal, now)
   │    - LLM proposes a manifest (nodes+edges+seed)
   │    - validated against the LIVE allowed capabilities
   │    - deny-by-default: unknown/ungranted caps rejected
   ▼
 signed Manifest saved                → shown in BuildPreviewModal (review before run)


 UI: "Run"  →  POST /api/runs          server.ts:635
   │  executeRun(runId, manifest, initialState, agentId)   runtime.ts:1887
   ▼
 new Engine(manifest, "default", runId, {store, supervisor, …})   runtime.ts
   │  engine.run({ initialState, approve:()=>false, … })   engine.ts:179
   ▼
 loop:  fold ledger → decide(manifest, projection)         engine.ts:220
   │       ├─ "start"   → append RunStarted (+ initialState)  engine.ts
   │       ├─ "enter"   → NodeEntered
   │       ├─ "runNode" → runNodeBody → supervisor.run(effect)  engine.ts:242
   │       │      - consequential effect + autonomy≠full → PARK (halted)
   │       │        append AwaitRequested, wait for human approval
   │       └─ terminal  → RunCompleted / RunFailed
   ▼
 result.status ∈ { completed | halted | failed }
```

**Human-in-the-loop (approval) resume:**

```
 run PARKS (halted) at a gated effect
   │  UI shows it under /approvals + /inbox ("awaiting you")
   ▼
 admin Approves  →  POST resolveApproval               runtime.ts:1502
   │  append AwaitResolved(approve) to the ledger
   ▼
 executeRun re-invoked → engine folds ledger → sees the resolution → proceeds
   │  (initialState is reconstructed FROM the ledger's RunStarted event — M2 fix)
   ▼
 the gated effect now runs → run continues to completion
```

**Verified:** `server.ts:648`, `runtime.ts:1887,1937,1951`; `engine.ts:179,220,242`;
approval resume `runtime.ts:1502,1538`; RunStarted-carries-initialState `engine.ts` (M2).

---

## 6. Delivery — where a completed run's output goes

```
 run completes → executeRun                          runtime.ts:1951
   │  agent has deliverTo targets?
   ▼
 deliverOutput(deliverTo, name, runId, state)        runtime.ts (src/api/delivery.ts)
   │  best-effort, never fails the run
   │  - resolve any *_ref delivery secret (decrypted in-memory only)
   ▼
 for each target:
   ├─ inbox     → already appears in the Agent Inbox (the guaranteed floor)
   ├─ email     → email_send plugin (Resend)
   ├─ telegram  → telegram_send (plain text; escapes if HTML)
   ├─ slack     → slack_send (SSRF-guarded webhook)
   ├─ webhook   → notify_webhook (SSRF-guarded)
   └─ sms/whatsapp/twitter/linkedin/discord → direct provider adapters (SSRF-guarded)
```

Delivery credentials set in the UI are stored encrypted in the SecretStore and referenced
by `*_ref`; the plaintext never sits on the agent record and is resolved only at send time.

**Verified:** `runtime.ts:1951` (deliverOutput), `src/api/delivery.ts` (channels + sanitize),
delivery-secret encryption `src/api/server.ts` (handleSetDelivery).

---

## 7. Marketplace / registry install (self-hosted, gated)

```
 Browse marketplace (public catalog from Git registry)     web/lib/registry.ts:70
   │
   ▼ admin clicks Install
   ├─ Template (whole agent)  → POST /api/templates/install   server.ts:210
   │     rt.installTemplate({ manifest, capabilities, secretRefs })
   │     - installs the connectors the template needs (transitive)
   │     - creates the agent (dedupes by name + shape)
   │     - reports which secrets to set
   │
   └─ Capability (a connector) → POST /api/capabilities        server.ts:240
         - YAML  : declarative, safe-by-construction
         - MCP   : approval-gated data, no in-process code
         - TS/JS : untrusted CODE — install extracts name STATICALLY (no execution);
                   enabling requires KRELVAN_ALLOW_UNTRUSTED_PLUGINS=1; runs in the
                   subprocess sandbox (write/spawn denied, fs-read scoped away from secrets,
                   network only via the brokered egress channel)
```

**Verified:** install/enable trust gate `src/core/plugins/lifecycle-service.ts`;
sandbox `src/infrastructure/plugins/subprocess-plugin-loader.ts`; registry `web/lib/registry.ts`.

---

## 8. Inbound trigger (an external system starts an agent)

```
 External POST  ──▶  /proxy/api/triggers/:agentId          public pass-through
   │  Authorization: Bearer <trigger-token>
   ▼
 proxy forwards the caller's bearer (never the admin token)   proxy/[...path]/route.ts
   ▼
 API validates the per-agent trigger token → starts a run     server.ts (handleWebhookTrigger)
   │  the POST body becomes the run's initialState
   ▼
 executeRun → same pipeline as §5 (build already done; just run)
```

Bad token → 401. The trigger token is minted per-agent in the UI (shown once).

---

## 9. End-to-end summary diagram

```
                 LIVE SITE (krelvan.com)                     SELF-HOSTED (customer's box)
        ┌───────────────────────────────────┐      ┌────────────────────────────────────────┐
 anyone │  homepage · marketplace directory  │      │  (private — 127.0.0.1 by default)        │
  ────▶ │  (public, no login)                │      │                                          │
        │        │                            │      │  npx krelvan → build → setup token →     │
        │        └─▶ "self-host it" ──────────┼──────┼─▶ create admin → login                   │
        └───────────────────────────────────┘      │        │                                  │
                                                    │        ▼  (admin workspace, gated)        │
                                                    │  describe → build (compile+sign) →        │
                                                    │  run (engine loop, HITL approvals) →      │
                                                    │  deliver (inbox/telegram/email/…) →       │
                                                    │  browse & install from marketplace        │
                                                    └────────────────────────────────────────┘
```

---

### Source index (for maintainers)

| Flow | File(s) |
|---|---|
| Page gate (public/gated) | `web/middleware.ts` |
| API gate + token injection | `web/app/proxy/[...path]/route.ts` |
| Setup / login / sessions | `src/api/admin-auth.ts`, `src/api/server.ts` (handleAuth*) |
| Launcher / boot / binding | `bin/krelvan.mjs`, `src/api/index.ts` |
| Build (compile) | `src/api/server.ts:467`, `runtime.ts` (buildAgent), `src/core/compiler/` |
| Run (engine loop) | `runtime.ts:1887` (executeRun), `src/core/kernel/engine.ts` |
| Approvals / resume | `runtime.ts:1502` (resolveApproval), `engine.ts` |
| Delivery | `runtime.ts:1951`, `src/api/delivery.ts` |
| Marketplace / registry | `web/lib/registry.ts`, `src/api/server.ts` (install*) |
| Plugin sandbox | `src/infrastructure/plugins/subprocess-plugin-loader.ts`, `src/core/plugins/lifecycle-service.ts` |
| Secrets at rest | `src/api/secret-store.ts` |
