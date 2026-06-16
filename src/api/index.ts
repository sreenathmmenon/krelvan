/**
 * Krelvan API — entry point.
 *
 * Usage (Anthropic — default):
 *   KRELVAN_ANTHROPIC_KEY=sk-ant-… npm run api
 *
 * Usage (OpenAI):
 *   KRELVAN_LLM_PROVIDER=openai KRELVAN_LLM_API_KEY=sk-… npm run api
 *
 * Usage (OpenRouter):
 *   KRELVAN_LLM_PROVIDER=openai
 *   KRELVAN_LLM_BASE_URL=https://openrouter.ai/api/v1
 *   KRELVAN_LLM_API_KEY=sk-or-…
 *   KRELVAN_LLM_MODEL=anthropic/claude-sonnet-4-6
 *
 * Usage (Ollama — local, no API key needed):
 *   KRELVAN_LLM_PROVIDER=ollama KRELVAN_LLM_MODEL=llama3.2 npm run api
 *
 * Data is persisted to ./data/ (ledger.db + JSON registries).
 */

import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { KrelvanRuntime } from "./runtime.js";
import { createApiServer } from "./server.js";
import { initAuth } from "./auth.js";
import { getLogger } from "../core/observability/logger.js";

// Load .env file before reading process.env — Node built-ins only, no third-party dotenv.
(function loadDotEnv() {
  const envPath = resolve(process.cwd(), ".env");
  if (!existsSync(envPath)) return;
  const lines = readFileSync(envPath, "utf8").split("\n");
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    const val = line.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (!(key in process.env)) process.env[key] = val;
  }
})();

const log = getLogger("main");

const PORT = Number(process.env["PORT"] ?? 3200);
const DATA_DIR = process.env["KRELVAN_DATA_DIR"] ?? "./data";
const CAPABILITIES_DIR = process.env["KRELVAN_CAPABILITIES_DIR"] ?? "./capabilities";

// Security: bind to loopback by default. Exposing to the network is a deliberate act
// (KRELVAN_HOST=0.0.0.0), and we refuse to start exposed without an auth token set,
// so an instance can never be open-to-the-world by accident.
const HOST = process.env["KRELVAN_HOST"] ?? "127.0.0.1";
const isLoopback = HOST === "127.0.0.1" || HOST === "::1" || HOST === "localhost";

// LLM config — new unified vars take precedence; KRELVAN_ANTHROPIC_KEY is legacy fallback
const LLM_PROVIDER = process.env["KRELVAN_LLM_PROVIDER"] ?? "anthropic";
const LLM_API_KEY = process.env["KRELVAN_LLM_API_KEY"] ?? process.env["KRELVAN_ANTHROPIC_KEY"];
const LLM_BASE_URL = process.env["KRELVAN_LLM_BASE_URL"];
const LLM_MODEL = process.env["KRELVAN_LLM_MODEL"];

const hasLlm = !!(LLM_API_KEY) || LLM_PROVIDER === "ollama";

async function main(): Promise<void> {
  log.info({
    port: PORT,
    dataDir: DATA_DIR,
    capsDir: CAPABILITIES_DIR,
    llmProvider: LLM_PROVIDER,
    llmModel: LLM_MODEL ?? "(provider default)",
    llmBaseUrl: LLM_BASE_URL ?? "(provider default)",
    hasLlm,
  }, "starting Krelvan API");

  const runtime = new KrelvanRuntime({
    dataDir: DATA_DIR,
    port: PORT,
    anthropicApiKey: LLM_API_KEY,
    llmProvider: LLM_PROVIDER,
    llmApiKey: LLM_API_KEY,
    llmBaseUrl: LLM_BASE_URL,
    llmModel: LLM_MODEL,
    capabilitiesDir: CAPABILITIES_DIR,
  });

  await runtime.init();

  // ── Authentication (Phase 1 token) ─────────────────────────────────────────
  mkdirSync(DATA_DIR, { recursive: true });
  const auth = initAuth(DATA_DIR);

  // Refuse to start exposed-to-the-network without a token. A freshly generated
  // token counts; the only failure mode is an explicitly-blanked env token while bound
  // to a non-loopback host. This makes "open to the world" impossible by accident.
  const tokenConfigured = !!auth.tokenHash;
  if (!isLoopback && !tokenConfigured) {
    log.error({ host: HOST }, "refusing to bind to a non-loopback host without an auth token. Set KRELVAN_AUTH_TOKEN or run on 127.0.0.1.");
    process.exit(1);
  }
  if (!isLoopback) {
    log.warn({ host: HOST }, "Krelvan is exposed to the network — ensure you front it with HTTPS (a token over plain HTTP can be sniffed).");
  }

  const server = createApiServer(runtime, auth);

  await new Promise<void>((resolve, reject) => {
    server.on("error", reject);
    server.listen(PORT, HOST, () => {
      log.info({ port: PORT, host: HOST }, "Krelvan API listening");
      resolve();
    });
  });

  // Print the token ONCE, only when freshly generated this run, in a clear banner.
  // We never log the token again, and the plaintext is never persisted.
  if (auth.generated && auth.freshPlaintext) {
    const webOrigin = process.env["KRELVAN_WEB_ORIGIN"] ?? "http://localhost:3100";
    /* eslint-disable no-console */
    console.log("\n" + "─".repeat(64));
    console.log("  Krelvan secured. Your access token (shown once — save it):\n");
    console.log("      " + auth.freshPlaintext + "\n");
    console.log("  Open the UI (already authenticated):");
    console.log("      " + webOrigin + "/?token=" + auth.freshPlaintext);
    console.log("\n  API calls:  Authorization: Bearer " + auth.freshPlaintext);
    console.log("  Rotate it:  delete " + resolve(DATA_DIR, "auth.token") + " and restart,");
    console.log("              or set KRELVAN_AUTH_TOKEN=<your-own>.");
    console.log("─".repeat(64) + "\n");
    /* eslint-enable no-console */
  }
}

main().catch((err) => {
  log.error({ err }, "fatal startup error");
  process.exit(1);
});
