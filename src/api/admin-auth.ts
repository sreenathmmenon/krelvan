/**
 * Krelvan admin authentication — WordPress-style first-run setup + username/password login
 * with server-side opaque sessions. Built to OWASP 2026 best practice using ONLY Node
 * built-ins (no third-party auth dependency — this removes the supply-chain attack class
 * that hit n8n / Mastra-MCP / LiteLLM).
 *
 * Security model:
 *  - PASSWORD: scrypt (memory-hard) at OWASP's high-security profile, stored self-describing
 *    so params can be raised later; verified in CONSTANT time. The scrypt hash is the only
 *    form of the password ever kept — plaintext is never stored or logged.
 *  - SESSION: an opaque 256-bit random token (NOT a JWT — opaque tokens are revocable and
 *    carry no forgeable claim). Only SHA-256(token) is stored, so a data/backup leak (the
 *    LiteLLM/n8n failure mode) cannot replay a live session. Idle + absolute expiry; the
 *    token is rotated on login and ALL sessions are killed on password change.
 *  - FIRST-RUN: a console-printed, short-lived setup token gates the setup endpoint (the
 *    PocketBase model) so a stranger reaching a fresh, network-exposed install FIRST cannot
 *    claim admin (the WordPress "claim window" hole).
 *  - ANTI-ENUMERATION: a missing user still incurs a full scrypt computation against a dummy
 *    hash, so response timing/CPU cannot reveal whether an account exists.
 *
 * State lives in <dataDir>/admin.auth (chmod 600) — NOT the customer secret store.
 */

import { scrypt, randomBytes, createHash, timingSafeEqual, createHmac, type ScryptOptions } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { getLogger } from "../core/observability/logger.js";

const log = getLogger("admin-auth");

/** Promise wrapper around scrypt that accepts the options object (memory-hard params). */
function scryptAsync(password: string, salt: Buffer, keylen: number, opts: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, opts, (err, derived) => (err ? reject(err) : resolve(derived)));
  });
}

// ── scrypt parameters (OWASP 2026 high-security; ~128 MiB/hash) ──────────────────
// Override via env on a small VPS (KRELVAN_SCRYPT_N=65536 => ~64 MiB).
const SCRYPT_N = Math.max(16384, Number(process.env["KRELVAN_SCRYPT_N"]) || 131072); // 2^17 default
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 32;
const SCRYPT_MAXMEM = 256 * 1024 * 1024; // must exceed 128*N*r; default 32MiB would throw

// ── session lifetimes (OWASP: 15–30m idle, 4–8h absolute) ────────────────────────
const SESSION_IDLE_MS = 30 * 60 * 1000;
const SESSION_ABSOLUTE_MS = 8 * 60 * 60 * 1000;
const SETUP_TOKEN_TTL_MS = 30 * 60 * 1000;

// ── login brute-force throttle (per-IP) ──────────────────────────────────────────
// scrypt is memory-hard (~128 MiB/hash), so unthrottled login is BOTH an online
// password-guessing oracle AND a memory-exhaustion DoS lever. We throttle per-IP
// BEFORE running scrypt, and globally cap concurrent scrypt computations.
const LOGIN_MAX_FAILS = 8;             // failures before per-IP lockout
const LOGIN_LOCK_MS = 15 * 60 * 1000;  // lockout duration after the cap is hit
const LOGIN_WINDOW_MS = 15 * 60 * 1000; // failures older than this don't count
// Concurrency cap on in-flight scrypt derivations. Each costs ~128 MiB, so this bounds
// peak login memory to ~CAP*128 MiB regardless of how many requests arrive at once.
// Override on a small VPS via KRELVAN_LOGIN_SCRYPT_CONCURRENCY.
const SCRYPT_CONCURRENCY = Math.max(1, Number(process.env["KRELVAN_LOGIN_SCRYPT_CONCURRENCY"]) || 4);
// Cap how many requests may WAIT for a scrypt slot. Without this, a huge simultaneous flood
// queues unbounded waiters (each pinning a request + its read body on the heap) — a lighter
// pressure vector than the OOM the semaphore already prevents, but still worth bounding. When
// the queue is full we fast-fail (the caller maps this to 503), shedding load deterministically.
const SCRYPT_MAX_QUEUE = Math.max(8, Number(process.env["KRELVAN_LOGIN_SCRYPT_MAX_QUEUE"]) || 64);

/** Thrown when the scrypt wait-queue is saturated, so the API can answer 503 (try later). */
export class ScryptOverloadError extends Error {
  constructor() { super("authentication service busy"); this.name = "ScryptOverloadError"; }
}

const b64 = (buf: Buffer): string => buf.toString("base64url");

// ── password hashing ─────────────────────────────────────────────────────────────

/** Hash a password with scrypt. Returns a self-describing `scrypt$N=..,r=..,p=..$salt$hash`. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = (await scryptAsync(password.normalize("NFC"), salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAXMEM,
  }));
  return `scrypt$N=${SCRYPT_N},r=${SCRYPT_R},p=${SCRYPT_P}$${b64(salt)}$${b64(hash)}`;
}

/** Verify a password against a stored hash in CONSTANT time. Old params still verify. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "scrypt") return false;
  const params = Object.fromEntries((parts[1] ?? "").split(",").map((kv) => kv.split("=")));
  const N = Number(params["N"]), r = Number(params["r"]), p = Number(params["p"]);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  let salt: Buffer, expected: Buffer;
  try { salt = Buffer.from(parts[2] ?? "", "base64url"); expected = Buffer.from(parts[3] ?? "", "base64url"); }
  catch { return false; }
  if (expected.length === 0) return false;
  let actual: Buffer;
  try {
    actual = (await scryptAsync(password.normalize("NFC"), salt, expected.length, { N, r, p, maxmem: SCRYPT_MAXMEM }));
  } catch { return false; }
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// ── stored admin record ──────────────────────────────────────────────────────────

interface AdminRecord { username: string; passwordHash: string; createdAt: number; updatedAt: number }

interface Session { userHash: string; createdAt: number; lastSeen: number; absoluteExpiry: number }

export class AdminAuth {
  private readonly file: string;
  private admin: AdminRecord | null = null;
  /** sha256(token, hex) → session. In-memory: a restart logs everyone out (acceptable, safe). */
  private readonly sessions = new Map<string, Session>();
  private setupToken: string | null = null;
  private setupTokenExpiry = 0;
  /** A precomputed real scrypt hash of random bytes, for constant-time anti-enumeration. */
  private dummyHashPromise: Promise<string>;
  /** Per-process CSRF signing secret (random each boot; double-submit tokens are short-lived). */
  private readonly csrfSecret = randomBytes(32);
  /** Per-IP login failure tracking → lockout (blunts online brute-force on the one admin). */
  private readonly loginFails = new Map<string, { count: number; first: number; lockedUntil: number }>();
  /** In-flight scrypt count + waiters — caps concurrent memory-hard derivations (DoS guard). */
  private scryptInFlight = 0;
  private readonly scryptWaiters: Array<() => void> = [];

  constructor(dataDir: string) {
    this.file = join(dataDir, "admin.auth");
    if (existsSync(this.file)) {
      try {
        const rec = JSON.parse(readFileSync(this.file, "utf8")) as AdminRecord;
        if (rec && typeof rec.username === "string" && typeof rec.passwordHash === "string") this.admin = rec;
      } catch { log.warn({}, "admin.auth unreadable — treating as not-yet-set-up"); }
    }
    this.dummyHashPromise = hashPassword(randomBytes(24).toString("hex"));
  }

  /** Has the admin account been created yet? */
  isSetup(): boolean { return this.admin !== null; }

  // ── first-run setup token (PocketBase model) ────────────────────────────────────

  /** If no admin yet, mint a setup token (kept in memory) and return it for the boot banner. */
  bootstrapSetupToken(): string | null {
    if (this.admin) return null;
    this.setupToken = randomBytes(32).toString("base64url");
    this.setupTokenExpiry = Date.now() + SETUP_TOKEN_TTL_MS;
    return this.setupToken;
  }

  private checkSetupToken(presented: string | undefined): boolean {
    if (!this.setupToken || Date.now() > this.setupTokenExpiry) return false;
    const a = Buffer.from(presented ?? "");
    const b = Buffer.from(this.setupToken);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  // ── login throttle + scrypt concurrency guard (DoS + brute-force defence) ─────────

  /** Is this IP currently locked out from login attempts? */
  isLoginLockedOut(ip: string): boolean {
    const r = this.loginFails.get(ip);
    return !!r && r.lockedUntil > Date.now();
  }

  private recordLoginFail(ip: string): void {
    const now = Date.now();
    const r = this.loginFails.get(ip);
    if (!r || now - r.first > LOGIN_WINDOW_MS) {
      this.loginFails.set(ip, { count: 1, first: now, lockedUntil: 0 });
      return;
    }
    r.count += 1;
    if (r.count >= LOGIN_MAX_FAILS) {
      r.lockedUntil = now + LOGIN_LOCK_MS;
      r.count = 0;
      r.first = now;
      log.warn({ ip }, "admin login: IP locked out after repeated failures");
    }
  }

  private clearLoginFails(ip: string): void {
    this.loginFails.delete(ip);
  }

  /**
   * Acquire a slot before running scrypt. Bounds peak login memory: at most
   * SCRYPT_CONCURRENCY derivations run at once; the rest await a freed slot. This turns a
   * flood of concurrent logins from an OOM lever into a bounded, slightly-slower queue.
   */
  private acquireScryptSlot(): Promise<void> {
    if (this.scryptInFlight < SCRYPT_CONCURRENCY) {
      this.scryptInFlight += 1;
      return Promise.resolve();
    }
    // Shed load deterministically once the wait-queue is saturated, rather than growing it
    // (and the heap) without bound under a flood.
    if (this.scryptWaiters.length >= SCRYPT_MAX_QUEUE) {
      return Promise.reject(new ScryptOverloadError());
    }
    return new Promise<void>((resolve) => this.scryptWaiters.push(resolve));
  }

  private releaseScryptSlot(): void {
    const next = this.scryptWaiters.shift();
    if (next) next(); // hand the slot directly to the next waiter (count stays the same)
    else this.scryptInFlight -= 1;
  }

  // ── setup / login / logout ──────────────────────────────────────────────────────

  /** Create the admin account. Requires the valid setup token (closes the claim window). */
  async setup(opts: { username: string; password: string; setupToken: string | undefined }):
    Promise<{ ok: true } | { ok: false; error: string }> {
    if (this.admin) return { ok: false, error: "already set up" };
    if (!this.checkSetupToken(opts.setupToken)) return { ok: false, error: "invalid or expired setup token" };
    const u = (opts.username ?? "").trim();
    if (!/^[a-zA-Z0-9._@-]{3,64}$/.test(u)) return { ok: false, error: "username must be 3–64 chars [a-zA-Z0-9._@-]" };
    if (typeof opts.password !== "string" || opts.password.length < 8 || opts.password.length > 256) {
      return { ok: false, error: "password must be 8–256 characters" };
    }
    // Close the claim window synchronously BEFORE the slow hash, so two same-tick setup
    // POSTs with the same valid token can't both pass (TOCTOU): the second sees no token.
    this.setupToken = null; this.setupTokenExpiry = 0; // single-use; window closed
    const now = Date.now();
    await this.acquireScryptSlot();
    let passwordHash: string;
    try { passwordHash = await hashPassword(opts.password); }
    finally { this.releaseScryptSlot(); }
    this.admin = { username: u, passwordHash, createdAt: now, updatedAt: now };
    this.persist();
    log.info({ username: u }, "admin account created");
    return { ok: true };
  }

  /**
   * Verify credentials in constant time (no user enumeration) and, on success, create a
   * fresh session. Returns the raw session token (goes into the cookie ONLY).
   *
   * `clientIp` drives the per-IP brute-force lockout; scrypt runs inside a global
   * concurrency cap so a flood of logins cannot exhaust memory. A locked-out caller is
   * rejected BEFORE any scrypt runs (so the lockout is also the DoS backstop).
   */
  async login(username: string, password: string, clientIp = "unknown"):
    Promise<{ ok: true; token: string } | { ok: false; lockedOut?: boolean; busy?: boolean }> {
    if (this.isLoginLockedOut(clientIp)) return { ok: false, lockedOut: true };
    const u = (username ?? "").trim();
    // ALWAYS run scrypt — against the real hash or the dummy — so timing can't reveal existence.
    const target = this.admin && this.admin.username === u ? this.admin.passwordHash : await this.dummyHashPromise;
    try {
      await this.acquireScryptSlot();
    } catch (e) {
      if (e instanceof ScryptOverloadError) return { ok: false, busy: true };
      throw e;
    }
    let ok: boolean;
    try {
      ok = await verifyPassword(password ?? "", target);
    } finally {
      this.releaseScryptSlot();
    }
    if (!this.admin || this.admin.username !== u || !ok) {
      this.recordLoginFail(clientIp);
      return { ok: false };
    }
    this.clearLoginFails(clientIp);
    return { ok: true, token: this.createSession() };
  }

  /** Change the admin password — kills ALL existing sessions (the revocation JWT can't do). */
  async changePassword(current: string, next: string):
    Promise<{ ok: true } | { ok: false; error: string }> {
    if (!this.admin) return { ok: false, error: "not set up" };
    // Both scrypt calls go through the same concurrency cap as login, so a logged-in admin
    // can't sidestep the global memory bound (defence-in-depth; this path is already authed).
    await this.acquireScryptSlot();
    let currentOk: boolean;
    try { currentOk = await verifyPassword(current ?? "", this.admin.passwordHash); }
    finally { this.releaseScryptSlot(); }
    if (!currentOk) return { ok: false, error: "current password incorrect" };
    if (typeof next !== "string" || next.length < 8 || next.length > 256) return { ok: false, error: "password must be 8–256 characters" };
    await this.acquireScryptSlot();
    let nextHash: string;
    try { nextHash = await hashPassword(next); }
    finally { this.releaseScryptSlot(); }
    this.admin = { ...this.admin, passwordHash: nextHash, updatedAt: Date.now() };
    this.persist();
    this.sessions.clear(); // revoke everything
    log.info({}, "admin password changed — all sessions revoked");
    return { ok: true };
  }

  // ── sessions ─────────────────────────────────────────────────────────────────────

  private static hashToken(token: string): string {
    return createHash("sha256").update(token).digest("hex");
  }

  private createSession(): string {
    const token = randomBytes(32).toString("base64url"); // 256-bit, sent to client
    const now = Date.now();
    this.sessions.set(AdminAuth.hashToken(token), {
      userHash: this.admin ? AdminAuth.hashToken(this.admin.username) : "",
      createdAt: now, lastSeen: now, absoluteExpiry: now + SESSION_ABSOLUTE_MS,
    });
    return token;
  }

  /** Validate a session token (idle + absolute window); slides the idle clock. */
  validateSession(token: string | undefined): boolean {
    if (!token) return false;
    const key = AdminAuth.hashToken(token);
    const s = this.sessions.get(key);
    if (!s) return false;
    const now = Date.now();
    if (now > s.absoluteExpiry || now - s.lastSeen > SESSION_IDLE_MS) {
      this.sessions.delete(key);
      return false;
    }
    s.lastSeen = now;
    return true;
  }

  /** Destroy a session (logout). */
  destroySession(token: string | undefined): void {
    if (token) this.sessions.delete(AdminAuth.hashToken(token));
  }

  /** Drop expired sessions (call periodically). */
  sweepExpired(): void {
    const now = Date.now();
    for (const [k, s] of this.sessions) {
      if (now > s.absoluteExpiry || now - s.lastSeen > SESSION_IDLE_MS) this.sessions.delete(k);
    }
  }

  // ── CSRF double-submit (HMAC-bound to the session) ────────────────────────────────

  issueCsrfToken(sessionToken: string): string {
    const nonce = randomBytes(16).toString("base64url");
    const mac = createHmac("sha256", this.csrfSecret).update(`${sessionToken}.${nonce}`).digest("base64url");
    return `${nonce}.${mac}`;
  }

  verifyCsrfToken(sessionToken: string | undefined, presented: string | undefined): boolean {
    if (!sessionToken || !presented) return false;
    const [nonce, mac] = presented.split(".");
    if (!nonce || !mac) return false;
    const expected = createHmac("sha256", this.csrfSecret).update(`${sessionToken}.${nonce}`).digest("base64url");
    const a = Buffer.from(mac), b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  private persist(): void {
    try {
      writeFileSync(this.file, JSON.stringify(this.admin), "utf8");
      try { chmodSync(this.file, 0o600); } catch { /* best-effort on platforms without chmod */ }
    } catch (e) { log.error({ err: (e as Error).message }, "failed to persist admin.auth"); }
  }
}
