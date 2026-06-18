/**
 * admin-auth unit tests — the security primitives. We use a smaller scrypt N for test speed
 * (KRELVAN_SCRYPT_N) but exercise the real hash/verify/session/setup/CSRF logic.
 */
process.env["KRELVAN_SCRYPT_N"] = "16384"; // fast for tests; production default is 2^17

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AdminAuth, hashPassword, verifyPassword } from "./admin-auth.js";

let dir: string;
before(() => { dir = mkdtempSync(join(tmpdir(), "krelvan-auth-")); });
after(() => rmSync(dir, { recursive: true, force: true }));

function fresh(): AdminAuth { return new AdminAuth(mkdtempSync(join(dir, "i-"))); }

test("hashPassword/verifyPassword: correct password verifies, wrong fails", async () => {
  const h = await hashPassword("correct horse battery staple");
  assert.match(h, /^scrypt\$N=\d+,r=8,p=1\$/);
  assert.equal(await verifyPassword("correct horse battery staple", h), true);
  assert.equal(await verifyPassword("wrong", h), false);
  assert.equal(await verifyPassword("", h), false);
});

test("verifyPassword: never throws on malformed stored hash", async () => {
  for (const bad of ["", "notscrypt$x$y$z", "scrypt$$", "scrypt$N=1,r=1,p=1$$", "x"]) {
    assert.equal(await verifyPassword("p", bad), false);
  }
});

test("verifyPassword: two hashes of the SAME password differ (unique salt)", async () => {
  const a = await hashPassword("same"), b = await hashPassword("same");
  assert.notEqual(a, b);
  assert.equal(await verifyPassword("same", a), true);
  assert.equal(await verifyPassword("same", b), true);
});

test("setup: requires a valid setup token (closes the claim window)", async () => {
  const a = fresh();
  assert.equal(a.isSetup(), false);
  // No token → rejected (a stranger reaching a fresh install can't claim admin).
  let r = await a.setup({ username: "admin", password: "password123", setupToken: undefined });
  assert.equal(r.ok, false);
  r = await a.setup({ username: "admin", password: "password123", setupToken: "wrong-token" });
  assert.equal(r.ok, false);
  // With the printed token → succeeds.
  const tok = a.bootstrapSetupToken();
  assert.ok(tok);
  r = await a.setup({ username: "admin", password: "password123", setupToken: tok! });
  assert.equal(r.ok, true);
  assert.equal(a.isSetup(), true);
});

test("setup: token is single-use — a second setup fails", async () => {
  const a = fresh();
  const tok = a.bootstrapSetupToken()!;
  await a.setup({ username: "admin", password: "password123", setupToken: tok });
  const r = await a.setup({ username: "admin2", password: "password456", setupToken: tok });
  assert.equal(r.ok, false); // already set up
});

test("setup: validates username + password strength", async () => {
  const a = fresh();
  const tok = a.bootstrapSetupToken()!;
  assert.equal((await a.setup({ username: "ab", password: "password123", setupToken: tok })).ok, false, "short username");
  assert.equal((await a.setup({ username: "admin", password: "short", setupToken: tok })).ok, false, "short password");
});

test("login: correct creds → session token; wrong → no session", async () => {
  const a = fresh();
  const tok = a.bootstrapSetupToken()!;
  await a.setup({ username: "alice", password: "password123", setupToken: tok });
  const good = await a.login("alice", "password123");
  assert.equal(good.ok, true);
  assert.ok(good.ok && good.token.length > 20);
  assert.equal((await a.login("alice", "wrong")).ok, false);
  assert.equal((await a.login("bob", "password123")).ok, false, "unknown user");
});

test("session: validate slides idle window, logout destroys it", async () => {
  const a = fresh();
  const tok = a.bootstrapSetupToken()!;
  await a.setup({ username: "alice", password: "password123", setupToken: tok });
  const r = await a.login("alice", "password123");
  assert.ok(r.ok);
  const sid = (r as { token: string }).token;
  assert.equal(a.validateSession(sid), true);
  assert.equal(a.validateSession("garbage"), false);
  assert.equal(a.validateSession(undefined), false);
  a.destroySession(sid);
  assert.equal(a.validateSession(sid), false, "destroyed session must not validate");
});

test("changePassword: kills ALL sessions (revocation)", async () => {
  const a = fresh();
  const tok = a.bootstrapSetupToken()!;
  await a.setup({ username: "alice", password: "password123", setupToken: tok });
  const s1 = (await a.login("alice", "password123") as { token: string }).token;
  const s2 = (await a.login("alice", "password123") as { token: string }).token;
  assert.equal(a.validateSession(s1), true);
  assert.equal(a.validateSession(s2), true);
  const r = await a.changePassword("password123", "newpassword456");
  assert.equal(r.ok, true);
  assert.equal(a.validateSession(s1), false, "all sessions revoked on pw change");
  assert.equal(a.validateSession(s2), false);
  // old password no longer works; new one does
  assert.equal((await a.login("alice", "password123")).ok, false);
  assert.equal((await a.login("alice", "newpassword456")).ok, true);
});

test("changePassword: wrong current password is rejected", async () => {
  const a = fresh();
  const tok = a.bootstrapSetupToken()!;
  await a.setup({ username: "alice", password: "password123", setupToken: tok });
  assert.equal((await a.changePassword("WRONG", "newpassword456")).ok, false);
});

test("persistence: admin survives a reload; sessions do not (in-memory)", async () => {
  const d = mkdtempSync(join(dir, "persist-"));
  const a1 = new AdminAuth(d);
  const tok = a1.bootstrapSetupToken()!;
  await a1.setup({ username: "alice", password: "password123", setupToken: tok });
  const sid = (await a1.login("alice", "password123") as { token: string }).token;
  // file written, chmod 600, contains the hash not the plaintext
  assert.ok(existsSync(join(d, "admin.auth")));
  const raw = readFileSync(join(d, "admin.auth"), "utf8");
  assert.match(raw, /scrypt\$/);
  assert.doesNotMatch(raw, /password123/, "plaintext password must never be persisted");
  // a NEW instance (restart) re-loads the admin but NOT the session
  const a2 = new AdminAuth(d);
  assert.equal(a2.isSetup(), true);
  assert.equal(a2.validateSession(sid), false, "sessions are in-memory; restart logs out");
  assert.equal((await a2.login("alice", "password123")).ok, true, "can log in again after restart");
});

test("CSRF: token verifies for its session, fails for another", async () => {
  const a = fresh();
  const tok = a.bootstrapSetupToken()!;
  await a.setup({ username: "alice", password: "password123", setupToken: tok });
  const sid = (await a.login("alice", "password123") as { token: string }).token;
  const csrf = a.issueCsrfToken(sid);
  assert.equal(a.verifyCsrfToken(sid, csrf), true);
  assert.equal(a.verifyCsrfToken("other-session", csrf), false, "CSRF token bound to its session");
  assert.equal(a.verifyCsrfToken(sid, "forged.value"), false);
  assert.equal(a.verifyCsrfToken(sid, undefined), false);
});

test("login brute-force: an IP is locked out after repeated wrong passwords", async () => {
  const a = fresh();
  const tok = a.bootstrapSetupToken()!;
  await a.setup({ username: "alice", password: "password123", setupToken: tok });
  const ip = "10.0.0.7";
  assert.equal(a.isLoginLockedOut(ip), false);
  // LOGIN_MAX_FAILS = 8 → the 8th failure trips the lockout.
  for (let i = 0; i < 8; i++) {
    const r = await a.login("alice", "wrong-" + i, ip);
    assert.equal(r.ok, false);
  }
  assert.equal(a.isLoginLockedOut(ip), true, "IP is locked out after 8 failures");
  // Even the CORRECT password is now refused, with lockedOut set, WITHOUT running scrypt.
  const blocked = await a.login("alice", "password123", ip);
  assert.equal(blocked.ok, false);
  assert.equal((blocked as { lockedOut?: boolean }).lockedOut, true, "locked out, not just wrong");
});

test("login lockout is PER-IP: a different IP is unaffected", async () => {
  const a = fresh();
  const tok = a.bootstrapSetupToken()!;
  await a.setup({ username: "alice", password: "password123", setupToken: tok });
  for (let i = 0; i < 8; i++) await a.login("alice", "wrong", "1.1.1.1");
  assert.equal(a.isLoginLockedOut("1.1.1.1"), true);
  assert.equal(a.isLoginLockedOut("2.2.2.2"), false, "a clean IP is not locked out");
  // The clean IP can still log in with the right password.
  assert.equal((await a.login("alice", "password123", "2.2.2.2")).ok, true);
});

test("login: a successful login clears that IP's failure count", async () => {
  const a = fresh();
  const tok = a.bootstrapSetupToken()!;
  await a.setup({ username: "alice", password: "password123", setupToken: tok });
  const ip = "9.9.9.9";
  for (let i = 0; i < 5; i++) await a.login("alice", "wrong", ip); // below the cap
  assert.equal((await a.login("alice", "password123", ip)).ok, true, "succeeds before lockout");
  // Counter reset → another 7 failures must NOT lock out (would need 8 fresh ones).
  for (let i = 0; i < 7; i++) await a.login("alice", "wrong", ip);
  assert.equal(a.isLoginLockedOut(ip), false, "success reset the counter");
});

test("scrypt overload: an oversaturated wait-queue sheds load with busy=true (not OOM)", async () => {
  // Tiny caps so the queue saturates fast and deterministically.
  process.env["KRELVAN_LOGIN_SCRYPT_CONCURRENCY"] = "1";
  process.env["KRELVAN_LOGIN_SCRYPT_MAX_QUEUE"] = "4";
  // Re-import a fresh module so the new env-derived caps take effect (query string busts the
  // module cache). The specifier is dynamic, so TS can't resolve it — that's intentional.
  // @ts-expect-error dynamic cache-busting specifier
  const mod = await import("./admin-auth.js?overload") as typeof import("./admin-auth.js");
  const a = new mod.AdminAuth(mkdtempSync(join(dir, "ov-")));
  const tok = a.bootstrapSetupToken()!;
  await a.setup({ username: "alice", password: "password123", setupToken: tok });
  // Fire many concurrent logins from distinct IPs: 1 runs, 4 queue, the rest must be shed.
  const results = await Promise.all(
    Array.from({ length: 30 }, (_, i) => a.login("alice", "password123", "ov-ip-" + i)),
  );
  const busy = results.filter((r) => (r as { busy?: boolean }).busy === true).length;
  const ok = results.filter((r) => r.ok === true).length;
  assert.ok(busy > 0, "some logins are shed with busy=true under overload");
  assert.ok(ok > 0, "some logins still succeed");
  assert.equal(busy + ok, 30, "every login resolves (none hang)");
  delete process.env["KRELVAN_LOGIN_SCRYPT_CONCURRENCY"];
  delete process.env["KRELVAN_LOGIN_SCRYPT_MAX_QUEUE"];
});

test("scrypt concurrency cap: many simultaneous logins all resolve (no crash, bounded)", async () => {
  const a = fresh();
  const tok = a.bootstrapSetupToken()!;
  await a.setup({ username: "alice", password: "password123", setupToken: tok });
  // Fire 20 concurrent logins from distinct IPs (so none lock out). The semaphore must
  // queue them and every promise must resolve — proving the cap can't deadlock or drop work.
  const results = await Promise.all(
    Array.from({ length: 20 }, (_, i) => a.login("alice", "password123", "ip-" + i)),
  );
  assert.equal(results.length, 20);
  assert.ok(results.every((r) => r.ok === true), "all concurrent logins succeed under the cap");
});
