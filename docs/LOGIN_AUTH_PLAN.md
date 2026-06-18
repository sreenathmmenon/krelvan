# Krelvan — WordPress-style Login (first-run setup + username/password + sessions)

*Production-grade web-UI authentication for the self-hosted product, built from OWASP-2026
best practice with **zero new dependencies** (Node `crypto` only). The bearer-token API path is
left 100% intact for headless/CI/agents — humans log in, machines use the token.*

## The seam (why this is surgical)

There is ONE place a browser request becomes an authenticated API call: the Next proxy
`web/app/proxy/[...path]/route.ts` injects `Authorization: Bearer <token>` for any same-origin
caller. Today that means "the browser is implicitly trusted → no login." The change: **gate that
injection on a valid session.** `src/api/auth.ts authenticate()` (the bearer check) is untouched, so
direct API callers / the `KRELVAN_AUTH_TOKEN` env path / CI keep working exactly as before.

```
Browser → /login (set session cookie) → proxy (verify session → inject bearer) → API authenticate(bearer)
Headless/agent → API authenticate(bearer)   [unchanged]
```

## Security decisions (OWASP 2026, built-ins only)

| Area | Decision |
|---|---|
| Password hash | `crypto.scrypt` N=2¹⁷ r=8 p=1 keylen=32, 16-byte salt, maxmem≈144MiB; stored `scrypt$N=..,r=..,p=..$salt$hash`; verify `timingSafeEqual`. (scrypt = OWASP's built-in choice; Argon2id needs a native addon.) Drop N to 2¹⁶ on small VPS. |
| Session | opaque `randomBytes(32)` (256-bit) token; store **sha256(token)** server-side; NOT JWT (revocation, no secret-in-token). |
| Cookie | `__Host-krelvan_sid` in prod (`HttpOnly; Secure; SameSite=Lax; Path=/`); plain `krelvan_sid` (no Secure/__Host) on http-localhost dev. |
| Lifetime | 30-min idle (sliding) + 8-hr absolute; rotate token on login; kill ALL sessions on password change. |
| First-run | WordPress wizard, PocketBase-safe: a console-printed 30-min **setup token** gates `/setup` so no stranger can claim admin on an exposed box. CLI fallback for headless. |
| CSRF | no state-change on GET + `Sec-Fetch-Site`/Origin check + HMAC double-submit token on writes. |
| Brute-force | always run scrypt (dummy hash for missing user → no enumeration); generic error; per-account exponential backoff + per-IP throttle (reuse existing lockout). |
| Exposed vs local | login ALWAYS required; never auto-detect exposure (a reverse proxy makes everything look like loopback). |
| HTTPS | front with Caddy; trust `X-Forwarded-Proto` only from the proxy; `Secure`/`__Host-` gated on a prod flag. |

## Where identity lives — decision: in the API core (Option B)

The core owns the admin identity + sessions (so "the ledger is the runtime" stays coherent and the
web tier stays a thin proxy). Add to the API:
- `<dataDir>/admin.auth` (chmod 600) = `{ username, passwordHash, createdAt }`. NOT the secret store
  (that's enumerable customer secrets).
- Sessions: in-memory map keyed by sha256(token) (+ optional on-disk for restart-survival later).
- New public-allowlisted endpoints: `POST /api/auth/setup`, `POST /api/auth/login`,
  `POST /api/auth/logout`, `GET /api/auth/status` (is-setup-needed / is-logged-in).
- `authenticate()` gains a **bearer-OR-session** fallthrough: env/CI bearer short-circuits first
  (unchanged), else accept a valid session token (passed by the proxy as a header). Pure addition.

The proxy reads the browser's session cookie, validates via `GET /api/auth/status` (or forwards the
session token to the API which validates), and only injects the bearer if the session is valid; else
401. Next middleware redirects unauthenticated page loads to `/setup` (first run) or `/login`.

## Build steps
1. **A — crypto core** (`src/api/admin-auth.ts`): scrypt hash/verify, session create/validate
   (hashed, idle+absolute), setup-token bootstrap, dummy-hash anti-enumeration. + unit tests.
2. **B — API endpoints** (`server.ts` + `auth.ts`): setup/login/logout/status routes, allowlist them,
   bearer-OR-session in `authenticate()`, CSRF + Sec-Fetch check on writes.
3. **C — proxy gate** (`web/app/proxy/.../route.ts`): forward session cookie → API validates; 401 if
   no session (this is the line that flips "no login" → "login required"). Login/logout set/clear cookie.
4. **D — web pages** (`web/app/login`, `web/app/setup`, `web/middleware.ts`): the WordPress wizard +
   login page + page-guard.
5. **E — launcher/boot**: print the setup link with the setup token on first run (replace the
   token-banner). Keep `KRELVAN_AUTH_TOKEN` working for headless.
6. **F — live test end-to-end**: first-run setup (with + without token), login (right/wrong/lockout),
   session (cookie set, idle/absolute expiry, logout), the API bearer path still works, CSRF blocks a
   forged write. Full suite + typecheck. Commit.

## Security audit + fixes (code-verified council)

After the build, a 5-expert code-verified security council adversarially audited the auth
(scrypt + sessions + setup-token + proxy gate). It returned median 6/10 and FIX-FIRST, with
two real HIGH findings that the build's own adversarial pass had missed. Both are now closed:

- **HIGH — login DoS + unthrottled brute-force.** `/api/auth/login` is on the public allowlist,
  so `authenticate()` returned `{ok:true}` BEFORE the per-IP lockout ran — the lockout never
  applied to login. Each attempt ran a ~128 MiB scrypt, so an unauthenticated attacker had both
  unlimited online password guessing AND a memory-exhaustion lever (a few dozen concurrent POSTs
  → multiple GiB).
  *Fix:* a per-IP login lockout (`loginFails`, 8 fails → 15 min) checked INSIDE `login()` BEFORE
  scrypt (a locked IP costs ~0), plus a global scrypt concurrency semaphore
  (`KRELVAN_LOGIN_SCRYPT_CONCURRENCY`, default 4) bounding peak login memory. `handleAuthLogin`
  returns 429 when locked. The scrypt wait-queue is itself bounded
  (`KRELVAN_LOGIN_SCRYPT_MAX_QUEUE`, default 64): once saturated, excess logins are shed with a
  503 rather than queueing unbounded waiters, so a flood can't pressure the heap either.
  `admin-auth.ts` / `server.ts`.

- **HIGH — CSRF double-submit was dead code.** `verifyCsrfToken()` was never called by any
  handler and `isSameOriginWrite()` guarded only login/setup, so every protected mutating route
  (`POST /api/runs`, `PUT /api/secrets`, `POST /api/mcp`, plugin install, `DELETE /api/agents`)
  rested on the `SameSite=Lax` cookie alone.
  *Fix:* the central auth gate now enforces `isSameOriginWrite(req)` AND
  `verifyCsrfToken(session, x-csrf-token)`, fail-closed 403, for every non-public mutating method
  on the SESSION (cookie) path. The BEARER path (machines/CI, no cookie) stays exempt.
  `isSameOriginWrite` tightened so only `sec-fetch-site: same-origin` passes for the browser path.

Also fixed (MEDIUM/LOW): SSE endpoint no longer sends `Access-Control-Allow-Origin: *` on an
auth-gated stream (scoped to the web origin); the session cookie uses the `__Host-` prefix and is
auto-`Secure` when the web origin is HTTPS (`web/lib/cookie.ts`); the setup-token claim window is
closed synchronously before the slow hash (no TOCTOU); expired sessions are swept on a timer; the
bearer token is header-only (the `?token=` query form, which leaks into logs/history, was removed);
`KRELVAN_TRUST_PROXY=1` lets the per-IP lockout see the real client behind a reverse proxy.

**Verification:** 16/16 admin-auth unit tests; 18/18 live adversarial checks (incl. CSRF enforced
on session writes, bearer path exempt, login lockout → 429, `?token=` rejected, forged CSRF/session
rejected); full browser flow via Chrome DevTools (login → HttpOnly cookie unreadable by JS →
authenticated dashboard → CSRF write round-trips → logout); full suite 279/282 (3 fails are the
documented live-model tests needing an API key); core + web typecheck clean.

## Honest scope
- ONE admin to start (WordPress baseline). Multiple users/roles + social login = separate later builds.
- Secures the web UI; the API stays token-based (correct: machines use tokens, humans log in).
- HTTPS is the operator's job (Caddy) — we set Secure cookies correctly behind a trusted proxy.
