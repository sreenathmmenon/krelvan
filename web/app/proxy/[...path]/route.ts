// Same-origin API proxy + session gate.
//
// The browser calls /proxy/api/... (same origin — no CORS). This server-side route
// forwards to the real Krelvan API, injecting:
//   - the bearer token (server-only env KRELVAN_AUTH_TOKEN — never reaches the browser), and
//   - the human SESSION token (from the krelvan_sid cookie) as X-Krelvan-Session.
//
// THE GATE: for every API call EXCEPT the public auth endpoints, a valid session cookie is
// required — without it the proxy returns 401, so a logged-out browser cannot use the API
// even though the proxy holds the bearer token. This is the single seam that turns
// "the UI just works" into "the UI requires login", WITHOUT touching the API's bearer auth
// (machines/CI keep using the token directly).

import { type NextRequest } from "next/server";
import { SESSION_COOKIE, COOKIE_SECURE, readSessionCookie } from "../../../lib/cookie";

// The backend origin the proxy forwards to. Prefer the explicit env var. When it's absent AND we
// are running on Vercel (VERCEL=1), default to the production backend — the hosted frontend has no
// local API to fall back to, and a bare localhost default would loop back into this same Next app
// (→ a redirect to /login for every API call). Local/self-hosted still defaults to localhost.
const API_ORIGIN =
  process.env["KRELVAN_API_ORIGIN"] ??
  (process.env["VERCEL"] ? "https://api.krelvan.com/proxy" : "http://localhost:3201");
const AUTH_TOKEN = process.env["KRELVAN_AUTH_TOKEN"] ?? "";

export const dynamic = "force-dynamic";

// API paths the browser may reach WITHOUT a session (you can't log in if login needs login).
const PUBLIC_API = new Set([
  "api/auth/status", "api/auth/login", "api/auth/logout", "api/auth/setup", "api/health", "api/status",
]);

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

async function forward(req: NextRequest, path: string[]): Promise<Response> {
  const apiPath = path.join("/");
  const session = readSessionCookie((n) => req.cookies.get(n)?.value);

  // The inbound webhook trigger (api/triggers/:agentId) is a PUBLIC, token-authed endpoint meant
  // to be called by external systems. It carries its own Authorization: Bearer <trigger-token>
  // which the API validates — no admin session, and we must PASS THROUGH the caller's bearer
  // (never inject the API token). This makes the copyable URL callable from anywhere.
  const isTrigger = apiPath.startsWith("api/triggers/");

  // A public artifact SHARE link (api/share/:token) is read-only and token-authenticated in the
  // API by the unguessable token in the path — no admin session, so a logged-out visitor can open
  // a shared output. It exposes only the rendered output (never a runId/internal id).
  const isShare = apiPath.startsWith("api/share/");

  // A public RUN-SHARE link (api/run-share/:token) is read-only and token-authenticated in the API.
  // A logged-out visitor can open a run's plain-English one-pager; it exposes only the agent name,
  // status, and explanation — never a runId/internal id.
  const isRunShare = apiPath.startsWith("api/run-share/");

  // The public Agent Front Door (api/public/*) — profile/feed reads gated by the agent's own
  // public flags, and /ask authenticated by a per-agent site key. No admin session; the /a/:slug
  // page and the widget reach it without cookies. (The API deny-by-defaults a disabled agent.)
  const isPublicAgent = apiPath.startsWith("api/public/");

  // GATE: non-public API calls require a valid session cookie.
  if (!PUBLIC_API.has(apiPath) && !isTrigger && !isShare && !isRunShare && !isPublicAgent && !session) {
    return json(401, { error: "not authenticated" });
  }

  const search = req.nextUrl.search; // preserves ?query
  const target = `${API_ORIGIN}/${apiPath}${search}`;

  const headers = new Headers();
  const ct = req.headers.get("content-type");
  if (ct) headers.set("content-type", ct);
  const accept = req.headers.get("accept");
  if (accept) headers.set("accept", accept);
  // Forward CSRF + Origin/Fetch-Metadata so the API can enforce same-origin on writes.
  const csrf = req.headers.get("x-csrf-token");
  if (csrf) headers.set("x-csrf-token", csrf);
  const origin = req.headers.get("origin");
  if (origin) headers.set("origin", origin);
  const sfs = req.headers.get("sec-fetch-site");
  if (sfs) headers.set("sec-fetch-site", sfs);

  // AUTHORIZATION model — the critical part:
  //  - For the PUBLIC auth endpoints (login/setup/status/logout), inject the bearer so the
  //    request can reach the API; these endpoints do their OWN credential checks.
  //  - For every PROTECTED route, do NOT inject the bearer. Forward ONLY the session token,
  //    so the API must validate the session itself. (If we injected the bearer here, a
  //    FORGED session cookie would still be authorized via the bearer — the gate would be
  //    bypassable. Forwarding session-only closes that hole.)
  if (PUBLIC_API.has(apiPath)) {
    if (AUTH_TOKEN) headers.set("authorization", `Bearer ${AUTH_TOKEN}`);
  }
  //  - For the inbound trigger route, forward the CALLER's own Authorization header (their
  //    trigger token) unchanged so the API validates it — do NOT inject the API bearer.
  if (isTrigger) {
    const auth = req.headers.get("authorization");
    if (auth) headers.set("authorization", auth);
  }
  if (session) headers.set("x-krelvan-session", session);

  const method = req.method.toUpperCase();
  const body = method === "GET" || method === "HEAD" ? undefined : await req.arrayBuffer();

  const upstream = await fetch(target, { method, headers, body, redirect: "manual", cache: "no-store" }).catch((e) => {
    return json(502, { error: `proxy: cannot reach API (${(e as Error).message})` });
  });

  // ── Login/setup: turn the returned session token into an HttpOnly cookie ──────────
  // The session token never reaches client JS — the proxy reads it from the JSON and sets
  // the cookie here. Secure/__Host- when behind HTTPS (KRELVAN_SECURE_COOKIES=1).
  if ((apiPath === "api/auth/login" || apiPath === "api/auth/setup") && upstream.status < 300) {
    const data = await upstream.clone().json().catch(() => null) as { session?: string; csrf?: string } | null;
    if (data?.session) {
      // __Host- prefix (over HTTPS) requires Secure + Path=/ + no Domain; the browser then
      // refuses any subdomain/HTTP override of the session. Plain name on local HTTP.
      const cookie = [
        `${SESSION_COOKIE}=${data.session}`,
        "HttpOnly", "SameSite=Lax", "Path=/", "Max-Age=28800",
        ...(COOKIE_SECURE ? ["Secure"] : []),
      ].join("; ");
      const h = new Headers({ "content-type": "application/json" });
      h.append("set-cookie", cookie);
      // Expose only the CSRF token to the client (NOT the session token).
      return new Response(JSON.stringify({ ok: true, csrf: data.csrf ?? null }), { status: 200, headers: h });
    }
  }

  // ── Logout: clear the cookie ──────────────────────────────────────────────────────
  if (apiPath === "api/auth/logout") {
    const h = new Headers({ "content-type": "application/json" });
    // Clear BOTH possible names so a scheme/config change can't strand a stale cookie.
    const attrs = `HttpOnly; SameSite=Lax; Path=/; Max-Age=0${COOKIE_SECURE ? "; Secure" : ""}`;
    h.append("set-cookie", `${SESSION_COOKIE}=; ${attrs}`);
    h.append("set-cookie", `krelvan_sid=; ${attrs}`);
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: h });
  }

  // Re-frame the response. `fetch` may have already DECODED the body (gzip/br) and re-chunked
  // it, so forwarding the original content-encoding/content-length would describe bytes that no
  // longer match — a real browser then waits forever for the missing bytes (a hang on the
  // keep-alive connection). Strip those + hop-by-hop headers and let the platform set framing.
  const respHeaders = new Headers(upstream.headers);
  for (const h of ["content-encoding", "content-length", "transfer-encoding", "connection",
    "keep-alive", "access-control-allow-origin"]) {
    respHeaders.delete(h);
  }
  // The public Agent Front Door is meant to be called cross-origin (the embeddable widget runs
  // on OTHER sites). Those routes carry no session/cookie — they are site-key-authed — so echo
  // the API's `*` CORS here too. Everything else stays same-origin only.
  if (isPublicAgent) {
    respHeaders.set("access-control-allow-origin", "*");
    respHeaders.set("vary", "Origin");
  }

  // SSE / event-streams must stay STREAMED (they never "complete").
  const ctype = upstream.headers.get("content-type") ?? "";
  if (ctype.includes("text/event-stream")) {
    return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: respHeaders });
  }

  // Everything else (JSON, text): BUFFER the whole body and return it as a complete, self-
  // contained response. This guarantees a clean content-length and a finished response so the
  // browser's keep-alive connection closes the request instead of hanging waiting for a stream.
  const buf = await upstream.arrayBuffer();
  return new Response(buf, { status: upstream.status, statusText: upstream.statusText, headers: respHeaders });
}

type Ctx = { params: Promise<{ path: string[] }> };

export async function GET(req: NextRequest, ctx: Ctx)    { return forward(req, (await ctx.params).path); }
export async function POST(req: NextRequest, ctx: Ctx)   { return forward(req, (await ctx.params).path); }
export async function PUT(req: NextRequest, ctx: Ctx)    { return forward(req, (await ctx.params).path); }
export async function PATCH(req: NextRequest, ctx: Ctx)  { return forward(req, (await ctx.params).path); }
export async function DELETE(req: NextRequest, ctx: Ctx) { return forward(req, (await ctx.params).path); }

// CORS preflight. Only the PUBLIC front door (/proxy/api/public/*) answers `*` — the embeddable
// widget on a third-party site sends a preflighted POST. Every other path is same-origin only,
// so a preflight there gets no allow-origin and the browser blocks it (as intended).
export async function OPTIONS(_req: NextRequest, ctx: Ctx) {
  const apiPath = (await ctx.params).path.join("/");
  if (apiPath.startsWith("api/public/")) {
    return new Response(null, { status: 204, headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-allow-headers": "Content-Type, X-Site-Key",
      "vary": "Origin",
    } });
  }
  return new Response(null, { status: 204 });
}
