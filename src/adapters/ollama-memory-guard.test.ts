import assert from "node:assert/strict";
import test from "node:test";
import { assertOllamaMemorySafe } from "./ollama-memory-guard.js";

function ollamaFetch(running: object[], available: object[]): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/api/ps")) return Response.json({ models: running });
    if (url.endsWith("/api/tags")) return Response.json({ models: available });
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

test("Ollama guard allows an installed model below the projected 85% ceiling", async () => {
  const report = await assertOllamaMemorySafe({
    baseUrl: "http://localhost:11434",
    model: "llama3.2",
    totalBytes: 1000,
    freeBytes: 500,
    fetchImpl: ollamaFetch([], [{ name: "llama3.2:latest", size: 100 }]),
  });
  assert.equal(report.projectedPercent, 62.5);
  assert.equal(report.modelBytesAdded, 125);
  assert.equal(report.alreadyLoaded, false);
});

test("Ollama guard refuses before loading a model that would cross 85%", async () => {
  await assert.rejects(
    assertOllamaMemorySafe({
      baseUrl: "http://localhost:11434",
      model: "large",
      totalBytes: 1000,
      freeBytes: 300,
      fetchImpl: ollamaFetch([], [{ name: "large:latest", size: 200 }]),
    }),
    (error: Error & { code?: string }) => error.code === "OLLAMA_MEMORY_LIMIT" && /95\.0%/.test(error.message),
  );
});
test("Ollama guard fails closed when an unloaded model has no size metadata", async () => {
  await assert.rejects(
    assertOllamaMemorySafe({
      baseUrl: "http://localhost:11434",
      model: "missing",
      totalBytes: 1000,
      freeBytes: 900,
      fetchImpl: ollamaFetch([], []),
    }),
    (error: Error & { code?: string }) => error.code === "OLLAMA_MODEL_SIZE_UNKNOWN",
  );
});

test("Ollama guard does not double-count a model already loaded", async () => {
  const report = await assertOllamaMemorySafe({
    baseUrl: "http://localhost:11434",
    model: "llama3.2",
    totalBytes: 1000,
    freeBytes: 300,
    fetchImpl: ollamaFetch([{ model: "llama3.2:latest", size: 200 }], []),
  });
  assert.equal(report.modelBytesAdded, 0);
  assert.equal(report.projectedPercent, 70);
  assert.equal(report.alreadyLoaded, true);
});

test("Ollama guard never accepts a configured limit above 85%", async () => {
  await assert.rejects(
    assertOllamaMemorySafe({
      baseUrl: "http://localhost:11434",
      model: "loaded",
      limitPercent: 99,
      totalBytes: 1000,
      freeBytes: 150,
      fetchImpl: ollamaFetch([{ name: "loaded:latest", size: 1 }], []),
    }),
    (error: Error & { code?: string }) => error.code === "OLLAMA_MEMORY_LIMIT" && /85%/.test(error.message),
  );
});
