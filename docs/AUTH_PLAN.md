# Krelvan — Authentication Plan

*Research + design for closing the council's #1 blocker: the API has zero auth and CORS `*`,
so anyone who can reach the port can read/set secrets, upload+enable a plugin (RCE), and resolve approvals.*

---

## 1. Verified current state (from the code, not docs)

- **No auth on any of ~40 routes.** `src/api/server.ts` `createServer → matchRoute → handler` has no auth middleware. (council-confirmed)
- **CORS `Access-Control-Allow-Origin: *`** on every response (`server.ts:163, 220, 415`).
- **Binds to all interfaces** — `server.listen(PORT)` with no host arg (`api/index.ts:86`), so it's reachable from the LAN/internet, not just loopback. This is what turns "no auth" from theoretical into a live exfiltration path.
- **Web (3100) and API (3201) are separate origins** — `web/lib/api.ts` calls `NEXT_PUBLIC_API_URL` cross-origin. (so cookies-across-ports are awkward; a bearer token is cleaner.)
- **One deployable** — `bin/krelvan up` starts API + web together, so first-run can mint and surface credentials.

The only "api key" in the code today is the *outbound LLM provider* key — never an *inbound* check.

---

## 2. How comparable tools solve this (researched)

| Tool | First-run model | Programmatic auth | Notes |
|---|---|---|---|
| **n8n** (closest analog) | **First user to hit the port becomes owner** via a setup wizard; until done, anyone can claim it. Can pre-provision owner via env. | API keys per user | "Trust on first use" — simple, but the unclaimed window is a real risk if exposed. |
| **plugin CMS** (your mental model) | Install wizard sets the admin user+password; `wp-admin` is cookie-session. | **Application Passwords** (since 5.6): per-app credentials, Basic-Auth over HTTPS, REST-only (can't log into dashboard). Browser uses **cookie + nonce** (`X-WP-Nonce`, CSRF). | Two-track: humans = cookie+nonce; machines = application passwords. Public-read endpoints are open; writes require auth. |
| **Grafana** | Ships with `admin/admin`, **forces password change on first login**. | API keys / service-account tokens (Viewer/Editor/Admin scopes). | Default-creds + forced-rotate is the classic pattern. |
| **Jupyter** | **Auto-generates a random token** at startup, prints it in the console; the URL includes `?token=…`. | Same token, or set a password. | "Token in the launch output" — zero config, secure by default. |
| **Gitea** | Install wizard creates the first admin. | Personal access tokens (scoped). | Wizard + PATs. |
| **Ollama** | None by default (localhost-only bind). | — | Safe *only* because it binds loopback; the moment you expose it, it's open — exactly Krelvan's situation. |

### The two durable patterns
1. **Jupyter / PocketBase pattern — auto-generated token, printed on launch.** Best for a single-binary self-host: secure by default, zero setup, nothing to forget. The token IS the credential.
2. **n8n/plugin CMS pattern — first-run owner + login.** Better UX for a multi-person product (real accounts, a login page), but adds a "claim window" and account storage.

### DECISIVE finding (this is why we should NOT copy plugin CMS's first-run model directly)
The "first user to reach the port claims the admin account" model (n8n, old plugin CMS/nginx-ui) has a **named, CVE-class vulnerability**: in the window between launch and you completing setup, **a network attacker can claim the admin account.** Real advisory: nginx-ui `GHSA-h27v-ph7w-m9fp` — "Unauthenticated First-Run Installer Allows Remote Initial Admin Claim."

**PocketBase — the single-binary product most similar to Krelvan — hit exactly this and changed its model in v0.23 (2024):** it now *auto-generates a secure superuser with a random password, mints a short-lived token, and prints an installer URL with that token* — i.e. it moved AWAY from open-first-run TO the token pattern. The official mitigation in the nginx-ui advisory is, almost verbatim: *"a single-use bootstrap secret generated on first start, printed to the console; restrict the installer to loopback until setup completes; remote setup requires explicit opt-in."*

**Conclusion: the token pattern is not just simpler — it is the security-correct one, independently arrived at by PocketBase and by the security community.** plugin CMS's *install-wizard-sets-admin* is the older model and carries the claim-window risk unless gated to loopback. So: **adopt the PocketBase/Jupyter token model now**, and when we add real accounts (Phase 2) we gate the account-creation wizard to **loopback + the bootstrap token** so we never reintroduce the claim-window hole.

For Krelvan **today** (single-tenant, single-owner, one binary), the **token pattern is the right first move**, with a clean path to the account model when multi-tenant lands.

### For the eventual account/login model: use Better Auth, don't hand-roll
When Phase 2 (real human accounts + login page) arrives, the modern default for a TypeScript stack like Krelvan is **Better Auth** — self-hosted, framework-agnostic, SQLite-compatible (matches Krelvan's embedded store), email/password + sessions + 2FA + OAuth + org/RBAC plugins, "don't write custom crypto." It maps cleanly onto Phases 2–3 below. (plugin CMS hand-rolls its own cookie+nonce+application-passwords; we'd get the same capabilities from Better Auth without writing auth crypto ourselves.)

---

## 3. Recommended design (phased)

### Phase 1 — Secure-by-default token (ship first; closes the blocker)
The minimum that makes the council's #1 finding go away, without hurting the local-dev experience.

- **On first `krelvan up`, generate a random `KRELVAN_AUTH_TOKEN`** (32 bytes, base64url) if none is set; persist it (chmod 600) and **print it + the pre-authed UI URL** in the launch output (Jupyter-style). Honor an env-provided token if set (for CI / reproducible deploys).
- **API: one auth middleware** in front of `matchRoute`. Every route requires the token via `Authorization: Bearer <token>` **except** a small public allowlist: `GET /api/health`, and the CORS `OPTIONS` preflight. Constant-time compare.
- **Loopback grace (DX):** if the request comes from `127.0.0.1`/`::1` **and** no token is configured yet, allow it (so `localhost` dev isn't broken on minute one). The moment a token exists or the bind is non-loopback, enforce.
- **Bind to `127.0.0.1` by default**, require an explicit `KRELVAN_HOST=0.0.0.0` (or `--host`) to expose — so "exposed" is a deliberate act, and exposing without a token refuses to start. (Defense in depth: the Ollama lesson.)
- **CORS:** stop using `*`. Reflect an allowlist (`KRELVAN_WEB_ORIGIN`, default `http://localhost:3100`); send `Access-Control-Allow-Credentials` only for that origin.
- **Web UI:** the web server is handed the token at launch (server-side env), exposes it to the client through a same-origin `/api/*` **proxy route** (so the token never ships to the browser as `NEXT_PUBLIC_*`). Browser → Next proxy (same origin, no CORS) → API with the bearer header. This also kills the cross-origin CORS problem entirely.

This is ~1 middleware + 1 token file + 1 proxy route + bind/CORS hardening. No accounts, no DB, no sessions. It makes every destructive endpoint require a secret.

### Phase 2 — Accounts, login & team management (the convergent industry model)

Researched how the comparable self-hosted products actually structure accounts — **GitHub, GitLab, Gitea, and n8n all converge on the SAME three-layer model.** This is the proven shape; we adopt it (not a one-off).

**The convergent model (do this):**

1. **A human login** — email + password (argon2id), httpOnly+SameSite **session cookie** for the browser, **CSRF token** for state-changing requests (this is exactly plugin CMS's cookie+nonce, just standard).
2. **Account types / roles** — n8n's clean tiering is the model: **Owner → Admin → Member**, instance-wide; plus per-project roles (Admin/Editor/Viewer) for finer control. This is also where the council's **separation-of-duties** lives (install-plugin vs approve-spend vs rotate-keys as distinct permissions).
3. **Personal Access Tokens (PATs)** — every one of GitHub/GitLab/Gitea/n8n offers scoped, revocable, per-user API tokens listed and created in the UI. **This is the plugin CMS "Application Password" by another name, and it's the universal standard.** It's how CI, agents, and integrations authenticate to Krelvan without a session. (Krelvan's Phase-1 bootstrap token is effectively the *first* PAT.)
4. **Team management** — Owner invites users by email; **invite-link fallback when no SMTP is configured** (n8n's pattern — critical for self-host, since most installs have no mail server). Users join, get a role.
5. **SSO (enterprise tier)** — every product adds **SAML + OIDC** at the enterprise level (GitHub Enterprise, GitLab self-managed, Gitea). We don't hand-roll this — **Better Auth** (the TS-ecosystem standard) ships email/password + sessions + 2FA + OAuth + **organizations/RBAC + SSO plugins**, runs on Krelvan's SQLite, and is "don't write your own auth crypto." That's Phase 3.

**How this maps to plugin CMS.org specifically (your model):**
- A plugin CMS *install* = Phase 2 here: `wp-admin` login (cookie+nonce) + **Application Passwords** for the REST API. We get the identical capability set, just via the GitHub/Gitea/Better-Auth idiom (sessions + PATs) instead of hand-rolled WP crypto.
- **plugin-cms.org the directory** (publisher accounts, 2FA, commit access to publish plugins) = a SEPARATE track = Krelvan's **marketplace publisher identity**, tied to the registry, not the runtime. Don't conflate.

**Why the PAT layer matters for YOUR audiences specifically:**
- **Outsourcing shops (Bobcares/Poornam) & SIs (Infosys/TCS/Accenture):** a per-client Krelvan with Owner/Admin/Member roles + PATs is exactly how they'd operate it — the agency is Owner, client staff are Members, their CI/automation uses PATs. This is the same model their engineers already know from GitHub/GitLab, so zero learning curve — a real adoption lever.
- **Separation-of-duties** (a council demand for enterprise) drops naturally out of the role layer: "only an Admin can approve a spend; only the Owner can rotate keys."

**Critical security rule carried from Phase 1:** the account-creation/first-run wizard is gated to **loopback + the bootstrap token**, so we get accounts WITHOUT reintroducing the plugin CMS/nginx-ui "claim-window" takeover hole.

### Phase 3 — Roles / SSO / multi-tenant (enterprise; aligns with the council's other asks)
- RBAC with **separation of duties** the council specifically called for: distinct roles for *install-plugin* vs *approve-spend* vs *rotate-keys* (so the approval gate isn't theater).
- **OIDC/SAML SSO** for enterprise; per-tenant principals replacing the hardcoded `owner-demo`.
- This is the same build as multi-tenancy (per-tenant token/secret/ledger namespaces) — do it once.

---

## 4. Why this ordering

- **Phase 1 alone flips the council's verdict on the #1 blocker** and is shippable in a focused pass — no schema changes, no accounts.
- It also **fixes the CORS `*` finding** (via the same-origin proxy) and the **network-exposure finding** (loopback-by-default) at the same seam.
- It does **not** prematurely build accounts/RBAC/SSO (Phases 2–3) before there's a multi-user need — matching the council's "don't build multi-tenancy before the boundary is sound" sequencing.
- The token is honest: it's a real secret enforced in code, so we can truthfully claim "the API is authenticated" — which the "trust made legible" positioning requires.

---

## 5. plugin CMS.org specifically (since it's the mental model)

Two things often conflated:
- **plugin-cms.org** (the *directory*) — accounts there are for publishing plugins/themes to the public registry; it's a hosted web app with normal login + 2FA, SVN/Git commit access for authors. That maps to Krelvan's **marketplace publisher identity** (a *later*, separate concern — the plugin council covered it).
- **A plugin CMS *install*** (your own site) — that's the analog for Krelvan's auth: install wizard sets the admin; `wp-admin` = cookie+nonce; REST API = application passwords. **Krelvan's Phase 1 token ≈ a single application password baked in at first run; Phase 2 ≈ the full wp-admin login + application-passwords model.**

So: Phase 1 is "the application password," Phase 2 is "wp-admin + application passwords," Phase 3 is "enterprise SSO/roles." The marketplace publisher login is a fourth, separate track tied to the registry, not the runtime.
