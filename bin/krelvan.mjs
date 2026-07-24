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
 *   PORT               public web UI port    (default 3100; this is the page you open)
 *   KRELVAN_WEB_PORT   web UI port (alias of PORT)
 *   KRELVAN_API_PORT   internal API port     (default 3201)
 *   KRELVAN_DATA_DIR   SQLite + registries   (default <repo>/data)
 *   KRELVAN_SKIP_BUILD set to "1" to skip the auto-build step
 *   LLM keys (KRELVAN_LLM_PROVIDER / KRELVAN_LLM_API_KEY / OPENAI_API_KEY /
 *     KRELVAN_ANTHROPIC_KEY …)
 *     enable LLM features; without them the UI runs and clearly reports LLM as off.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const WEB = join(ROOT, "web");

// Node version gate — a cryptic failure on an old Node reads as "the product is broken".
// Fail clearly and early with the exact requirement instead. (Krelvan needs Node 22+.)
{
  const major = Number(process.versions.node.split(".")[0]);
  if (Number.isFinite(major) && major < 22) {
    console.error(`\n  Krelvan needs Node 22 or newer — you have ${process.version}.`);
    console.error(`  Install Node 22+ (https://nodejs.org) and try again.\n`);
    process.exit(1);
  }
}

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
const WEB_PORT = process.env.PORT ?? process.env.KRELVAN_WEB_PORT ?? "3100";
// The API runs on a fixed INTERNAL port. If a PaaS injects PORT equal to the API's default
// (e.g. Railway sets PORT=3201), the web and API would bind the SAME port and the container
// crashes with EADDRINUSE. Guard against that: if the API port collides with the public web
// port, move the API to a different internal port. (The web proxy reads KRELVAN_API_ORIGIN,
// which the launcher derives from API_PORT below, so this stays consistent.)
let API_PORT = process.env.KRELVAN_API_PORT ?? "3201";
if (API_PORT === WEB_PORT) API_PORT = WEB_PORT === "3211" ? "3212" : "3211";
const installedPackage = ROOT.split(sep).includes("node_modules");
const userDataBase = process.platform === "win32"
  ? process.env.LOCALAPPDATA
  : process.env.XDG_DATA_HOME;
const stableUserDataDir = userDataBase
  ? join(userDataBase, "krelvan")
  : join(homedir(), ".krelvan");
// npx/global packages live in package-manager directories that may be deleted during cache
// cleanup or upgrades. Installed copies therefore default to stable per-user storage, while a
// source checkout retains the familiar repository-local ./data default.
const DATA_DIR = process.env.KRELVAN_DATA_DIR ?? (installedPackage ? stableUserDataDir : join(ROOT, "data"));
const SKIP_BUILD = process.env.KRELVAN_SKIP_BUILD === "1";

const args = process.argv.slice(2);
const helpRequested = args.includes("--help") || args.includes("-h");
const cmd = args[0] && !args[0].startsWith("-") ? args[0] : "up";
const apiOnly = args.includes("--api-only");

function log(msg) {
  process.stdout.write(`\x1b[36m[krelvan]\x1b[0m ${msg}\n`);
}
function warn(msg) {
  process.stdout.write(`\x1b[33m[krelvan]\x1b[0m ${msg}\n`);
}

if (cmd === "help" || helpRequested) {
  process.stdout.write(`krelvan — own, run, and trust your own AI agents.

Usage:
  krelvan [up]          build if needed, then start the API + web UI
  krelvan up --api-only start only the API (no web UI)
  krelvan hello         your first agent in one command: run it, hold its signed proof
  krelvan verify <file> verify an exported run proof bundle, offline
  krelvan help          show this help

Environment (all optional):
  PORT=${WEB_PORT}              public web UI port (this is the page you open)
  KRELVAN_WEB_PORT=${WEB_PORT}    web UI port (alias of PORT)
  KRELVAN_API_PORT=${API_PORT}    internal API port
  KRELVAN_DATA_DIR        SQLite ledger + registries dir (default ./data)
  KRELVAN_SKIP_BUILD=1    skip the automatic build step
  KRELVAN_LLM_PROVIDER / KRELVAN_LLM_API_KEY (or OPENAI_API_KEY / KRELVAN_ANTHROPIC_KEY)
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
    // The build is `tsc`, which lives in the root devDependencies. A customer who
    // runs `npx krelvan` (or clones and runs directly) has NO root node_modules —
    // npx only fetches the package's own `dependencies`, never its devDependencies —
    // so `tsc` isn't on PATH and the build dies with "command not found" (exit 127).
    // Install root deps first when they're missing, exactly as we do for the web UI.
    if (!existsSync(join(ROOT, "node_modules", ".bin", "tsc"))) {
      log("installing core dependencies (first run)…");
      await run(NPM, ["ci", "--ignore-scripts"], { cwd: ROOT });
    }
    log("building core (tsc)…");
    await run(NPM, ["run", "build"], { cwd: ROOT });
  } else {
    log("core already built (dist/) — skipping");
  }

  if (apiOnly) return;

  // 2. Web deps
  if (!existsSync(join(WEB, "node_modules"))) {
    if (!existsSync(join(WEB, "package-lock.json"))) {
      throw new Error("web/package-lock.json is missing — refusing an unpinned dependency install");
    }
    log("installing pinned web UI dependencies (first run)…");
    // Install scripts are unnecessary for Krelvan's JS runtime and are a common package
    // supply-chain execution path. The committed lockfile pins every fetched artifact.
    await run(NPM, ["ci", "--ignore-scripts"], { cwd: WEB });
  }

  // 3. Web build → web/.next
  //
  // The UI talks to the API via a SAME-ORIGIN proxy at runtime (app/proxy/[...path]),
  // so there is no build-time API URL to inline — the build is portable across ports
  // and the API origin is read from server env at start. Just build if not present.
  const needBuild = !existsSync(join(WEB, ".next"));
  if (needBuild) {
    log("building the web UI — first run only, this takes ~2-3 minutes. Later starts take seconds…");
    await run(NPM, ["run", "build"], {
      cwd: WEB,
      env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
    });
  } else {
    log("web UI already built (web/.next) — skipping");
  }
}

const children = [];
let shuttingDown = false;

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  // Set the exit code IMMEDIATELY. The forced-exit below runs on a timer, and an
  // .unref()'d timer lets Node exit on its own the moment the event loop empties —
  // which, on an early build failure with no live children, is right now, at the
  // default exit code 0. That produced a FALSE SUCCESS: the build died (127) but the
  // launcher reported 0, so CI/automation read a broken install as working. Pinning
  // process.exitCode guarantees the real code even if Node exits before the timer.
  process.exitCode = code;
  log("shutting down…");
  for (const child of children) {
    if (!child.killed) {
      try { child.kill("SIGTERM"); } catch { /* already gone */ }
    }
  }
  // Give children a moment to exit, then force. NOT .unref()'d — we want this timer
  // to keep the process alive long enough to SIGKILL stragglers; without live
  // children it fires and exits promptly anyway, now with the correct code.
  setTimeout(() => {
    for (const child of children) {
      if (!child.killed) {
        try { child.kill("SIGKILL"); } catch { /* already gone */ }
      }
    }
    process.exit(code);
  }, 2000);
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

  const envLlmProvider = process.env.KRELVAN_LLM_PROVIDER ?? "anthropic";
  const envHasLlm =
    !!process.env.KRELVAN_LLM_API_KEY ||
    (envLlmProvider === "openai" && !!process.env.OPENAI_API_KEY) ||
    (envLlmProvider === "anthropic" && !!process.env.KRELVAN_ANTHROPIC_KEY) ||
    envLlmProvider === "ollama";

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
  // The web UI is the public face. The API prints the first-run setup link against KRELVAN_WEB_ORIGIN,
  // so pass the ACTUAL web origin (the port we serve the UI on) — otherwise the API defaults to
  // :3100 and the printed setup link 404s when the UI is on another port. Respect an explicit
  // KRELVAN_WEB_ORIGIN (e.g. a real domain behind HTTPS) if the operator set one.
  const webOrigin = process.env.KRELVAN_WEB_ORIGIN ?? `http://localhost:${WEB_PORT}`;

  log(`starting API on ${apiOrigin}  (data: ${DATA_DIR})`);
  startProcess("api", process.execPath, [join(ROOT, "dist", "api", "index.js")], {
    cwd: ROOT,
    env: { ...process.env, PORT: API_PORT, KRELVAN_DATA_DIR: DATA_DIR, KRELVAN_AUTH_TOKEN: AUTH_TOKEN, KRELVAN_WEB_ORIGIN: webOrigin },
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
    //
    // Bind the web UI to LOOPBACK by default — exposing it to a network is a DELIBERATE act,
    // mirroring the API. Otherwise `npx krelvan` on a shared/cloud box would silently put the
    // login page and session cookie on the network in plain HTTP. To expose (e.g. behind a
    // reverse proxy), set KRELVAN_WEB_HOST=0.0.0.0 — and front it with HTTPS.
    //
    // EXCEPTION — a PaaS (Railway/Render/Fly/Heroku) injects PORT and terminates HTTPS at its
    // edge, then routes to the container. There the process MUST bind 0.0.0.0 or the edge gets a
    // 502 ("application failed to respond"). So when PORT is injected and no explicit web host is
    // set, default to 0.0.0.0 — the PaaS edge already provides HTTPS.
    // PORT is also the documented local port override; it is not proof that we are on
    // a managed platform. Inferring "cloud" from PORT alone silently exposed a local
    // custom-port install on every interface. Detect platform-specific markers instead.
    const onPaaS = !!(
      process.env.RAILWAY_ENVIRONMENT ||
      process.env.RAILWAY_ENVIRONMENT_NAME ||
      process.env.RENDER ||
      process.env.FLY_APP_NAME ||
      process.env.DYNO ||
      process.env.K_SERVICE
    );
    const WEB_HOST = process.env.KRELVAN_WEB_HOST ?? (onPaaS ? "0.0.0.0" : "127.0.0.1");
    const webLoopback = WEB_HOST === "127.0.0.1" || WEB_HOST === "::1" || WEB_HOST === "localhost";
    if (!webLoopback) {
      log(`⚠  web UI is binding to ${WEB_HOST} (network-exposed). Put it behind HTTPS (e.g. Caddy/nginx) and set KRELVAN_SECURE_COOKIES=1 — the login and session cookie are plain HTTP otherwise.`);
    }
    startProcess("web", nextBin, ["start", "-p", WEB_PORT, "-H", WEB_HOST], {
      cwd: WEB,
      // KRELVAN_SECURE_COOKIES=1 makes the session cookie Secure. On a PaaS the edge terminates
      // HTTPS, so default it on there (unless explicitly overridden) — otherwise the browser
      // sends the login form over HTTPS but the Secure-less cookie handling can misbehave behind
      // the proxy. KRELVAN_WEB_ORIGIN is the public origin for the CSRF/Origin check.
      env: {
        ...process.env,
        KRELVAN_API_ORIGIN: apiOrigin,
        KRELVAN_AUTH_TOKEN: AUTH_TOKEN,
        ...(onPaaS && process.env.KRELVAN_SECURE_COOKIES === undefined ? { KRELVAN_SECURE_COOKIES: "1" } : {}),
      },
    });
  }

  // Banner after a short delay so it lands below child startup logs.
  setTimeout(async () => {
    // Ask the running API for the effective status. This includes encrypted in-app settings,
    // which the launcher intentionally cannot decrypt and which may differ from the environment.
    // If the API is still starting, fall back to the environment without delaying startup.
    let llmStatus = {
      hasLlm: envHasLlm,
      provider: envLlmProvider,
      model: process.env.KRELVAN_LLM_MODEL ?? null,
      source: "env",
    };
    try {
      const response = await fetch(`${apiOrigin}/api/status`, { signal: AbortSignal.timeout(1500) });
      if (response.ok) {
        const current = await response.json();
        if (typeof current?.hasLlm === "boolean" && typeof current?.provider === "string") {
          llmStatus = {
            hasLlm: current.hasLlm,
            provider: current.provider,
            model: typeof current.model === "string" ? current.model : null,
            source: current.source === "in-app" ? "in-app" : "env",
          };
        }
      }
    } catch { /* API is still starting; the environment fallback remains accurate enough */ }
    const llmLabel = llmStatus.hasLlm
      ? `configured (${llmStatus.provider}${llmStatus.model ? ` · ${llmStatus.model}` : ""}${llmStatus.source === "in-app" ? " · saved in Settings" : ""})`
      : "not configured (open Settings → Model & secrets, or set an LLM environment variable)";
    process.stdout.write(
      `\n\x1b[32m\x1b[1m  Krelvan is up.\x1b[0m\n` +
      (apiOnly ? "" : `  Web UI   \x1b[4mhttp://localhost:${WEB_PORT}\x1b[0m\n`) +
      `  API      \x1b[4mhttp://localhost:${API_PORT}/api/health\x1b[0m\n` +
      `  LLM      ${llmLabel}\n` +
      `  Data     ${DATA_DIR}\n\n  Press Ctrl-C to stop.\n\n`,
    );
  }, 1500).unref();
}

up().catch((err) => {
  warn(err.message);
  shutdown(1);
});
