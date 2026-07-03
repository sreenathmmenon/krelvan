#!/usr/bin/env node
/**
 * krelvan — one-command launcher for the Krelvan self-host product.
 *
 * Boots the whole product from a fresh clone:
 *   - builds the core (tsc) and the web UI (next build) if they aren't built yet,
 *     installing web dependencies on first run,
 *   - starts the API server (Node http, SQLite ledger),
 *   - starts the web UI (next start), wired to talk to the API,
 *   - prints the local URLs,
 *   - shuts both processes down cleanly on Ctrl-C.
 *
 * Node built-ins only — no third-party launcher dependency.
 *
 * Usage:
 *   npx krelvan            # same as `up`
 *   npx krelvan up         # build if needed, then start API + web
 *   npx krelvan up --api-only
 *   npx krelvan help
 *
 * Env (all optional — the UI boots with no secrets):
 *   PORT               API port              (default 3201)
 *   KRELVAN_WEB_PORT   web UI port           (default 3100)
 *   KRELVAN_DATA_DIR   SQLite + registries   (default <repo>/data)
 *   KRELVAN_SKIP_BUILD set to "1" to skip the auto-build step
 *   LLM keys (KRELVAN_LLM_PROVIDER / KRELVAN_LLM_API_KEY / KRELVAN_ANTHROPIC_KEY …)
 *     enable LLM features; without them the UI runs and clearly reports LLM as off.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const WEB = join(ROOT, "web");

// Load .env (Node built-ins only) BEFORE reading config so ports / data dir /
// LLM banner reflect the user's .env. The API process loads it again
// independently; reading it here keeps the launcher's own decisions accurate.
(function loadDotEnv() {
  const envPath = join(ROOT, ".env");
  if (!existsSync(envPath)) return;
  for (const raw of readFileSync(envPath, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    const val = line.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (!(key in process.env)) process.env[key] = val;
  }
})();

// Port model — works on a single-port PaaS (Railway/Render/Fly) AND locally.
// The PUBLIC face is the WEB UI: on a PaaS it must bind to the injected $PORT, since
// that's where public traffic + the healthcheck go. The API runs on a fixed INTERNAL
// port that only the web's same-origin proxy reaches over localhost (never exposed).
//   - $PORT (PaaS-injected)        -> web UI port            (public)
//   - KRELVAN_WEB_PORT             -> web UI port override   (default 3100 locally)
//   - KRELVAN_API_PORT             -> internal API port      (default 3201)
const API_PORT = process.env.KRELVAN_API_PORT ?? "3201";
const WEB_PORT = process.env.PORT ?? process.env.KRELVAN_WEB_PORT ?? "3100";
const DATA_DIR = process.env.KRELVAN_DATA_DIR ?? join(ROOT, "data");
const SKIP_BUILD = process.env.KRELVAN_SKIP_BUILD === "1";

const args = process.argv.slice(2);
const cmd = args[0] && !args[0].startsWith("-") ? args[0] : "up";
const apiOnly = args.includes("--api-only");

function log(msg) {
  process.stdout.write(`\x1b[36m[krelvan]\x1b[0m ${msg}\n`);
}
function warn(msg) {
  process.stdout.write(`\x1b[33m[krelvan]\x1b[0m ${msg}\n`);
}

if (cmd === "help" || cmd === "--help" || cmd === "-h") {
  process.stdout.write(`krelvan — own, run, and trust your own AI agents.

Usage:
  krelvan [up]          build if needed, then start the API + web UI
  krelvan up --api-only start only the API (no web UI)
  krelvan hello         your first agent in one command: run it, hold its signed proof
  krelvan verify <file> verify an exported run proof bundle, offline
  krelvan help          show this help

Environment (all optional):
  PORT=${API_PORT}              API port
  KRELVAN_WEB_PORT=${WEB_PORT}    web UI port
  KRELVAN_DATA_DIR        SQLite ledger + registries dir (default ./data)
  KRELVAN_SKIP_BUILD=1    skip the automatic build step
  KRELVAN_LLM_PROVIDER / KRELVAN_LLM_API_KEY (or KRELVAN_ANTHROPIC_KEY)
                          enable LLM features; without a key the UI still runs.

Once up:
  Web UI   http://localhost:${WEB_PORT}
  API      http://localhost:${API_PORT}/api/health
`);
  process.exit(0);
}

// `krelvan verify <proof.json>` — delegate to the standalone, zero-dep offline verifier.
if (cmd === "verify") {
  const { spawnSync } = await import("node:child_process");
  const r = spawnSync(process.execPath, [join(__dirname, "krelvan-verify.mjs"), ...args.slice(1)], { stdio: "inherit", shell: false });
  process.exit(r.status ?? 0);
}

// `krelvan hello` — the first-run magic moment: build a tiny real agent, run it through
// the real signed ledger, export the proof bundle, verify it — zero keys, zero config,
// no server, no model. Needs only the CORE build (tsc), not the web UI.
if (cmd === "hello") {
  const { spawnSync } = await import("node:child_process");
  const { existsSync: exists } = await import("node:fs");
  const helloJs = join(ROOT, "dist", "cli", "hello.js");
  if (!exists(helloJs)) {
    log("first run — building the core (tsc)…");
    const b = spawnSync(NPM_BIN(), ["run", "build"], { cwd: ROOT, stdio: "inherit", shell: false });
    if ((b.status ?? 1) !== 0) { console.error("build failed"); process.exit(1); }
  }
  const r = spawnSync(process.execPath, [helloJs], { stdio: "inherit", shell: false });
  process.exit(r.status ?? 0);
}

function NPM_BIN() { return process.platform === "win32" ? "npm.cmd" : "npm"; }

/** Run a command to completion, inheriting stdio. Rejects on non-zero exit. */
function run(command, cmdArgs, opts = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, cmdArgs, { stdio: "inherit", shell: false, ...opts });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${command} ${cmdArgs.join(" ")} exited with code ${code}`));
    });
  });
}

const NPM = process.platform === "win32" ? "npm.cmd" : "npm";

async function ensureBuilt() {
  if (SKIP_BUILD) {
    log("KRELVAN_SKIP_BUILD=1 — skipping build step");
    return;
  }

  // 1. Core build → dist/api/index.js
  if (!existsSync(join(ROOT, "dist", "api", "index.js"))) {
    log("building core (tsc)…");
    await run(NPM, ["run", "build"], { cwd: ROOT });
  } else {
    log("core already built (dist/) — skipping");
  }

  if (apiOnly) return;

  // 2. Web deps
  if (!existsSync(join(WEB, "node_modules"))) {
    log("installing web UI dependencies (first run)…");
    await run(NPM, ["install"], { cwd: WEB });
  }

  // 3. Web build → web/.next
  //
  // The UI talks to the API via a SAME-ORIGIN proxy at runtime (app/proxy/[...path]),
  // so there is no build-time API URL to inline — the build is portable across ports
  // and the API origin is read from server env at start. Just build if not present.
  const needBuild = !existsSync(join(WEB, ".next"));
  if (needBuild) {
    log("building web UI (next build)…");
    await run(NPM, ["run", "build"], { cwd: WEB, env: { ...process.env } });
  } else {
    log("web UI already built (web/.next) — skipping");
  }
}

const children = [];
let shuttingDown = false;

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  log("shutting down…");
  for (const child of children) {
    if (!child.killed) {
      try { child.kill("SIGTERM"); } catch { /* already gone */ }
    }
  }
  // Give children a moment to exit, then force.
  setTimeout(() => {
    for (const child of children) {
      if (!child.killed) {
        try { child.kill("SIGKILL"); } catch { /* already gone */ }
      }
    }
    process.exit(code);
  }, 2000).unref();
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

function startProcess(name, command, cmdArgs, opts) {
  const child = spawn(command, cmdArgs, { stdio: "inherit", shell: false, ...opts });
  children.push(child);
  child.on("error", (err) => {
    warn(`${name} failed to start: ${err.message}`);
    shutdown(1);
  });
  child.on("exit", (code) => {
    if (shuttingDown) return;
    warn(`${name} exited unexpectedly (code ${code}) — stopping everything`);
    shutdown(code ?? 1);
  });
  return child;
}

async function up() {
  mkdirSync(DATA_DIR, { recursive: true });
  await ensureBuilt();

  const hasLlm =
    !!(process.env.KRELVAN_LLM_API_KEY || process.env.KRELVAN_ANTHROPIC_KEY) ||
    process.env.KRELVAN_LLM_PROVIDER === "ollama";

  // ── Auth: derive ONE shared token and give it to both processes ────────────
  // The launcher owns the plaintext so it can hand it to the web proxy (which
  // injects it server-side). If the user set KRELVAN_AUTH_TOKEN we honor it; else
  // we reuse a persisted launcher token, else mint a new one. The API receives the
  // same token via env (its initAuth env-precedence path), so both agree.
  const tokenFile = join(DATA_DIR, "launcher.token");
  let AUTH_TOKEN = process.env.KRELVAN_AUTH_TOKEN;
  if (!AUTH_TOKEN) {
    if (existsSync(tokenFile)) {
      try { AUTH_TOKEN = readFileSync(tokenFile, "utf8").trim(); } catch { AUTH_TOKEN = ""; }
    }
    if (!AUTH_TOKEN) {
      AUTH_TOKEN = randomBytes(32).toString("base64url");
      try { writeFileSync(tokenFile, AUTH_TOKEN, "utf8"); chmodSync(tokenFile, 0o600); } catch { /* best-effort */ }
    }
  }
  const apiOrigin = `http://localhost:${API_PORT}`;

  log(`starting API on ${apiOrigin}  (data: ${DATA_DIR})`);
  startProcess("api", process.execPath, [join(ROOT, "dist", "api", "index.js")], {
    cwd: ROOT,
    env: { ...process.env, PORT: API_PORT, KRELVAN_DATA_DIR: DATA_DIR, KRELVAN_AUTH_TOKEN: AUTH_TOKEN },
  });

  if (!apiOnly) {
    log(`starting web UI on http://localhost:${WEB_PORT}…`);
    const nextBin = join(
      WEB,
      "node_modules",
      ".bin",
      process.platform === "win32" ? "next.cmd" : "next",
    );
    // Web talks to the API through its same-origin proxy; the token + API origin are
    // SERVER-ONLY env (no NEXT_PUBLIC_), so the token never reaches the browser.
    // Bind the web to 0.0.0.0 so a PaaS (Railway/Render/Fly) can route public traffic
    // to it. The API stays on loopback (internal-only); only the web proxy reaches it.
    startProcess("web", nextBin, ["start", "-p", WEB_PORT, "-H", "0.0.0.0"], {
      cwd: WEB,
      // KRELVAN_SECURE_COOKIES=1 (set it when fronted by HTTPS, e.g. behind Caddy) makes the
      // session cookie Secure. KRELVAN_WEB_ORIGIN is the public origin for the CSRF/Origin check.
      env: { ...process.env, KRELVAN_API_ORIGIN: apiOrigin, KRELVAN_AUTH_TOKEN: AUTH_TOKEN },
    });
  }

  // Banner after a short delay so it lands below child startup logs.
  setTimeout(() => {
    process.stdout.write(
      `\n\x1b[32m\x1b[1m  Krelvan is up.\x1b[0m\n` +
      (apiOnly ? "" : `  Web UI   \x1b[4mhttp://localhost:${WEB_PORT}\x1b[0m\n`) +
      `  API      \x1b[4mhttp://localhost:${API_PORT}/api/health\x1b[0m\n` +
      `  LLM      ${hasLlm ? "configured" : "not configured (set KRELVAN_LLM_API_KEY or KRELVAN_ANTHROPIC_KEY to enable agent building / explanations)"}\n` +
      `  Data     ${DATA_DIR}\n\n  Press Ctrl-C to stop.\n\n`,
    );
  }, 1500).unref();
}

up().catch((err) => {
  warn(err.message);
  shutdown(1);
});
