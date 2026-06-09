/**
 * Genesis API — entry point.
 *
 * Usage (Anthropic — default):
 *   GENESIS_ANTHROPIC_KEY=sk-ant-… npm run api
 *
 * Usage (OpenAI):
 *   GENESIS_LLM_PROVIDER=openai GENESIS_LLM_API_KEY=sk-… npm run api
 *
 * Usage (OpenRouter):
 *   GENESIS_LLM_PROVIDER=openai
 *   GENESIS_LLM_BASE_URL=https://openrouter.ai/api/v1
 *   GENESIS_LLM_API_KEY=sk-or-…
 *   GENESIS_LLM_MODEL=anthropic/claude-sonnet-4-6
 *
 * Usage (Ollama — local, no API key needed):
 *   GENESIS_LLM_PROVIDER=ollama GENESIS_LLM_MODEL=llama3.2 npm run api
 *
 * Data is persisted to ./data/ (ledger.db + JSON registries).
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { GenesisRuntime } from "./runtime.js";
import { createApiServer } from "./server.js";
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
const DATA_DIR = process.env["GENESIS_DATA_DIR"] ?? "./data";
const CAPABILITIES_DIR = process.env["GENESIS_CAPABILITIES_DIR"] ?? "./capabilities";

// LLM config — new unified vars take precedence; GENESIS_ANTHROPIC_KEY is legacy fallback
const LLM_PROVIDER = process.env["GENESIS_LLM_PROVIDER"] ?? "anthropic";
const LLM_API_KEY = process.env["GENESIS_LLM_API_KEY"] ?? process.env["GENESIS_ANTHROPIC_KEY"];
const LLM_BASE_URL = process.env["GENESIS_LLM_BASE_URL"];
const LLM_MODEL = process.env["GENESIS_LLM_MODEL"];

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
  }, "starting Genesis API");

  const runtime = new GenesisRuntime({
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

  const server = createApiServer(runtime);

  await new Promise<void>((resolve, reject) => {
    server.on("error", reject);
    server.listen(PORT, () => {
      log.info({ port: PORT }, "Genesis API listening");
      resolve();
    });
  });
}

main().catch((err) => {
  log.error({ err }, "fatal startup error");
  process.exit(1);
});
