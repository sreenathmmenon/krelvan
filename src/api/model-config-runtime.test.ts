import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { KrelvanRuntime } from "./runtime.js";

const MODEL_ENV_NAMES = [
  "KRELVAN_LLM_PROVIDER",
  "KRELVAN_LLM_API_KEY",
  "KRELVAN_LLM_MODEL",
  "KRELVAN_LLM_BASE_URL",
] as const;

test("in-app model config survives restart and clearing restores constructor defaults", () => {
  const dir = mkdtempSync(join(tmpdir(), "krelvan-model-config-"));
  const previous = Object.fromEntries(MODEL_ENV_NAMES.map((name) => [name, process.env[name]]));
  const config = {
    port: 0,
    dataDir: join(dir, "data"),
    capabilitiesDir: join(dir, "capabilities"),
    llmProvider: "anthropic",
    llmApiKey: "constructor-anthropic-key",
    llmModel: "constructor-anthropic-model",
  };

  try {
    const first = new KrelvanRuntime(config);
    const saved = first.setModelConfig({
      provider: "openai",
      apiKey: "stored-openai-key",
      model: "gpt-5.6-sol",
    });
    assert.equal(saved.ok, true);
    assert.deepEqual(first.modelStatus, {
      hasLlm: true,
      provider: "openai",
      model: "gpt-5.6-sol",
      source: "in-app",
    });
    assert.equal(process.env["KRELVAN_LLM_PROVIDER"], "openai");
    assert.equal(process.env["KRELVAN_LLM_API_KEY"], "stored-openai-key");
    first.store.close();

    // A fresh runtime must restore the encrypted in-app values before a built-in
    // capability creates the shared model client.
    for (const name of MODEL_ENV_NAMES) delete process.env[name];
    const restarted = new KrelvanRuntime(config);
    assert.deepEqual(restarted.modelStatus, {
      hasLlm: true,
      provider: "openai",
      model: "gpt-5.6-sol",
      source: "in-app",
    });
    assert.equal(process.env["KRELVAN_LLM_PROVIDER"], "openai");
    assert.equal(process.env["KRELVAN_LLM_API_KEY"], "stored-openai-key");
    assert.equal(process.env["KRELVAN_LLM_MODEL"], "gpt-5.6-sol");

    const cleared = restarted.setModelConfig({
      provider: "",
      apiKey: "",
      model: "",
      baseUrl: "",
    });
    assert.equal(cleared.ok, true);
    assert.deepEqual(restarted.modelStatus, {
      hasLlm: true,
      provider: "anthropic",
      model: "constructor-anthropic-model",
      source: "env",
    });
    assert.equal(process.env["KRELVAN_LLM_PROVIDER"], "anthropic");
    assert.equal(process.env["KRELVAN_LLM_API_KEY"], "constructor-anthropic-key");
    assert.equal(process.env["KRELVAN_LLM_MODEL"], "constructor-anthropic-model");
    restarted.store.close();
  } finally {
    for (const name of MODEL_ENV_NAMES) {
      const value = previous[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
