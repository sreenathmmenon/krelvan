/**
 * Krelvan API authentication — Phase 1: a secure-by-default bearer token.
 *
 * Model (PocketBase/Jupyter-style, the security-correct choice for a single-binary
 * self-host — see docs/AUTH_PLAN.md):
 *   - On first start, if no token is configured, generate a 256-bit random token,
 *     persist only its SHA-256 HASH to `<dataDir>/auth.token` (chmod 600), and return
 *     the plaintext ONCE so the launcher can print it. The plaintext is never stored.
 *   - Every request must carry `Authorization: Bearer <token>` EXCEPT a tiny public
 *     allowlist (health + CORS preflight). Comparison is constant-time over hashes.
 *   - Repeated failures from one IP trigger a lockout (blunts brute-force / spray).
 *
 * Hardening implemented here: random 256-bit token · stored hashed, never plaintext ·
 * constant-time compare · per-IP rate-limit + lockout · never logs the token.
 * (Bind-to-loopback, refuse-exposed-without-token, CORS allowlist, and the same-origin
 * proxy live in index.ts / server.ts / the web app.)
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { join } from "node:path";
import type { IncomingMessage } from "node:http";
import { getLogger } from "../core/observability/logger.js";

const log = getLogger("auth");

function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

export interface AuthState {
  /** sha256(token) — the only form of the token we keep in memory/disk */
  tokenHash: string;
  /** true if the token was generated this run (so the launcher prints it once) */
  generated: boolean;
  /** the plaintext token IFF generated this run; undefined otherwise (never persisted) */
  freshPlaintext?: string;
}

/**
 * Load the configured token (env wins), else load the persisted hash, else generate a
 * new token and persist its hash. Returns the auth state for the server + launcher.
 */
export function initAuth(dataDir: string): AuthState {
  // 1. Explicit env token (CI / reproducible deploys) — highest precedence.
  const envToken = process.env["KRELVAN_AUTH_TOKEN"];
  if (envToken && envToken.trim()) {
    return { tokenHash: sha256Hex(envToken.trim()), generated: false };
  }

  const tokenFile = join(dataDir, "auth.token");

  // 2. Previously generated — load the persisted hash (never the plaintext; we don't have it).
  if (existsSync(tokenFile)) {
    try {
      const stored = readFileSync(tokenFile, "utf8").trim();
      if (/^[a-f0-9]{64}$/.test(stored)) {
        return { tokenHash: stored, generated: false };
      }
      log.warn({}, "auth.token file malformed — regenerating");
    } catch (err) {
      log.warn({ err }, "could not read auth.token — regenerating");
    }
  }

  // 3. First run — mint a 256-bit token, persist ONLY its hash (chmod 600).
  const plaintext = randomBytes(32).toString("base64url");
  const hash = sha256Hex(plaintext);
  try {
    writeFileSync(tokenFile, hash + "\n", "utf8");
    try { chmodSync(tokenFile, 0o600); } catch { /* best-effort on platforms without chmod */ }
  } catch (err) {
    log.warn({ err }, "could not persist auth token hash — token will change on restart");
  }
  return { tokenHash: hash, generated: true, freshPlaintext: plaintext };
}

// ── per-IP rate limiting / lockout ──────────────────────────────────────────────
const MAX_FAILS = 10;          // failures before lockout
const LOCK_MS = 5 * 60_000;    // lockout duration
const WINDOW_MS = 5 * 60_000;  // failures older than this don't count
interface FailRecord { count: number; first: number; lockedUntil: number }
const failsByIp = new Map<string, FailRecord>();

/**
 * Client IP for rate-limiting. Self-host default: trust the socket peer (no XFF spoofing
 * surface). When fronted by a trusted reverse proxy that terminates TLS, set
 * KRELVAN_TRUST_PROXY=1 so the per-IP lockout sees the real client instead of collapsing
 * every request into the proxy's single IP (which would turn the lockout into a self-DoS).
 */
export function clientIp(req: IncomingMessage): string {
  if (process.env["KRELVAN_TRUST_PROXY"] === "1") {
    const xff = req.headers["x-forwarded-for"];
    const first = (Array.isArray(xff) ? xff[0] : xff)?.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.socket.remoteAddress ?? "unknown";
}

function isLockedOut(ip: string, now: number): boolean {
  const r = failsByIp.get(ip);
  return !!r && r.lockedUntil > now;
}

function recordFail(ip: string, now: number): void {
  const r = failsByIp.get(ip);
  if (!r || now - r.first > WINDOW_MS) {
    failsByIp.set(ip, { count: 1, first: now, lockedUntil: 0 });
    return;
  }
  r.count += 1;
  if (r.count >= MAX_FAILS) {
    r.lockedUntil = now + LOCK_MS;
    r.count = 0;
    r.first = now;
    log.warn({ ip }, "auth: IP locked out after repeated failures");
  }
}

function clearFails(ip: string): void {
  failsByIp.delete(ip);
}

/**
 * Extract the bearer token from the Authorization header. Header-only by design: a token in
 * the query string leaks into browser history, Referer headers, and access logs, so we do
 * NOT accept `?token=`.
 */
function presentedToken(req: IncomingMessage): string | null {
  const h = req.headers["authorization"];
  if (typeof h === "string" && h.startsWith("Bearer ")) return h.slice(7).trim();
  return null;
}

export type AuthOutcome =
  | { ok: true }
  | { ok: false; status: number; message: string };

/**
 * Authenticate a request. Public paths skip auth. A request is authorized if it carries
 * EITHER a valid bearer token (machines/CI/headless — unchanged) OR a valid human session
 * (the web UI, forwarded by the proxy). The bearer path short-circuits FIRST, so the
 * env-token / CI path is never affected by the session layer.
 *
 * @param sessionValid optional predicate over the forwarded session token (from the proxy).
 */
export function authenticate(
  req: IncomingMessage,
  url: URL,
  state: AuthState,
  sessionValid?: (token: string | undefined) => boolean,
): AuthOutcome {
  // public allowlist — read-only, no data exposure
  if (url.pathname === "/api/health") return { ok: true };
  // readiness (is a model configured) — boolean + provider name only, no secrets.
  if (url.pathname === "/api/status") return { ok: true };
  // Ledger signing PUBLIC keys: publishable by design so an external auditor can verify
  // the ledger without a token. Public-key material only — never a secret.
  if (url.pathname === "/api/ledger/keys") return { ok: true };
  // Auth endpoints must be reachable WITHOUT a session (you can't log in if login needs a
  // login). They do their own credential checks + rate-limiting internally.
  if (url.pathname === "/api/auth/status" || url.pathname === "/api/auth/login" ||
      url.pathname === "/api/auth/logout" || url.pathname === "/api/auth/setup") return { ok: true };

  const ip = clientIp(req);
  const now = Date.now();

  if (isLockedOut(ip, now)) {
    return { ok: false, status: 429, message: "too many failed attempts — try again later" };
  }

  // 1) Bearer token (machines / CI / agents) — the original path, unchanged.
  const token = presentedToken(req);
  if (token) {
    const presentedHash = sha256Hex(token);
    if (timingSafeEqual(Buffer.from(presentedHash, "hex"), Buffer.from(state.tokenHash, "hex"))) {
      clearFails(ip);
      return { ok: true };
    }
  }

  // 2) Human session (forwarded by the proxy as X-Krelvan-Session) — additive.
  if (sessionValid) {
    const sess = req.headers["x-krelvan-session"];
    if (typeof sess === "string" && sessionValid(sess)) {
      clearFails(ip);
      return { ok: true };
    }
  }

  recordFail(ip, now);
  return { ok: false, status: 401, message: "authentication required" };
}
