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
  "KRELVAN_EMBED_PROVIDER",
  "KRELVAN_EMBED_API_KEY",
  "KRELVAN_EMBED_MODEL",
  "KRELVAN_EMBED_BASE_URL",
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
      configuredProviders: ["anthropic", "openai"],
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
      configuredProviders: ["anthropic", "openai"],
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
      configuredProviders: ["anthropic"],
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

test("adding and switching providers preserves each encrypted provider profile", () => {
  const dir = mkdtempSync(join(tmpdir(), "krelvan-model-profiles-"));
  const previous = Object.fromEntries(MODEL_ENV_NAMES.map((name) => [name, process.env[name]]));
  for (const name of MODEL_ENV_NAMES) delete process.env[name];

  try {
    const runtime = new KrelvanRuntime({
      port: 0,
      dataDir: join(dir, "data"),
      capabilitiesDir: join(dir, "capabilities"),
    });

    assert.equal(runtime.setModelConfig({
      provider: "anthropic",
      apiKey: "anthropic-profile-key",
      model: "anthropic-profile-model",
    }).ok, true);
    assert.equal(runtime.setModelConfig({
      provider: "openai",
      apiKey: "openai-profile-key",
      model: "openai-profile-model",
    }).ok, true);

    assert.deepEqual(runtime.modelStatus, {
      hasLlm: true,
      provider: "openai",
      model: "openai-profile-model",
      source: "in-app",
      configuredProviders: ["anthropic", "openai"],
    });
    assert.equal(runtime.setModelConfig({ provider: "anthropic" }).ok, true);
    assert.equal(runtime.modelStatus.model, "anthropic-profile-model");
    assert.equal(process.env["KRELVAN_LLM_API_KEY"], "anthropic-profile-key");
    // Anthropic has no embeddings API. The centrally configured OpenAI profile is selected
    // for every embedding capability, without changing the active chat provider.
    assert.equal(process.env["KRELVAN_EMBED_PROVIDER"], "openai");
    assert.equal(process.env["KRELVAN_EMBED_API_KEY"], "openai-profile-key");

    assert.equal(runtime.setModelConfig({ provider: "openai" }).ok, true);
    assert.equal(runtime.modelStatus.model, "openai-profile-model");
    assert.equal(process.env["KRELVAN_LLM_API_KEY"], "openai-profile-key");
    // The active provider can embed, so no separate override is necessary.
    assert.equal(process.env["KRELVAN_EMBED_PROVIDER"], undefined);
    assert.equal(process.env["KRELVAN_EMBED_API_KEY"], undefined);

    // A self-hosted OpenAI-compatible endpoint can intentionally be keyless. Its required
    // base URL is enough to make the profile usable; hosted compatible gateways can still
    // save their own key in the same profile.
    assert.equal(runtime.setModelConfig({
      provider: "compatible",
      baseUrl: "http://127.0.0.1:8080/v1",
      model: "customer-model",
    }).ok, true);
    assert.equal(runtime.modelStatus.hasLlm, true);
    assert.deepEqual(runtime.modelStatus.configuredProviders, ["anthropic", "openai", "compatible"]);
    runtime.store.close();
  } finally {
    for (const name of MODEL_ENV_NAMES) {
      const value = previous[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
