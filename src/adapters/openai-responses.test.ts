import { test } from "node:test";
import assert from "node:assert/strict";

import {
  makeLLMClient,
  resolveProviderApiKey,
  type LLMRequest,
} from "./llm-client.js";
import { AnthropicModel } from "./anthropic-model.js";

const REQUEST: LLMRequest = {
  system: "Return the requested value.",
  messages: [{ role: "user", content: "Say hello." }],
  model: "gpt-5.6-sol",
  maxTokens: 128,
  temperature: 0,
};

test("OpenAI uses the Responses API with the official request and response shape", async () => {
  let seenUrl = "";
  let seenInit: RequestInit | undefined;
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    seenUrl = String(url);
    seenInit = init;
    return new Response(JSON.stringify({
      status: "completed",
      output: [{
        type: "message",
        content: [{ type: "output_text", text: "hello" }],
      }],
      usage: { input_tokens: 7, output_tokens: 2 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  const client = makeLLMClient({
    provider: "openai",
    apiKey: "sk-test",
    fetchImpl,
  });
  const result = await client.complete(REQUEST);

  assert.equal(seenUrl, "https://api.openai.com/v1/responses");
  assert.equal(new Headers(seenInit?.headers).get("authorization"), "Bearer sk-test");
  const body = JSON.parse(String(seenInit?.body)) as Record<string, unknown>;
  assert.equal(body["model"], "gpt-5.6-sol");
  assert.equal(body["instructions"], REQUEST.system);
  assert.deepEqual(body["input"], REQUEST.messages);
  assert.equal(body["max_output_tokens"], 128);
  assert.equal(body["store"], false);
  assert.equal("temperature" in body, false);
  assert.equal("messages" in body, false);
  assert.equal("max_tokens" in body, false);
  assert.deepEqual(result, { text: "hello", inputTokens: 7, outputTokens: 2 });
});

test("OpenAI structured output is sent through Responses text.format", async () => {
  let body: Record<string, unknown> = {};
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({
      status: "completed",
      output: [{
        type: "message",
        content: [{ type: "output_text", text: "{\"answer\":\"hello\"}" }],
      }],
      usage: { input_tokens: 8, output_tokens: 4 },
    }), { status: 200 });
  }) as typeof fetch;

  const client = makeLLMClient({ provider: "openai", apiKey: "sk-test", fetchImpl });
  await client.complete({
    ...REQUEST,
    schema: {
      name: "answer",
      schema: {
        type: "object",
        properties: { answer: { type: "string" } },
        required: ["answer"],
        additionalProperties: false,
      },
    },
  });

  assert.deepEqual(body["text"], {
    format: {
      type: "json_schema",
      name: "answer",
      strict: true,
      schema: {
        type: "object",
        properties: { answer: { type: "string" } },
        required: ["answer"],
        additionalProperties: false,
      },
    },
  });
  assert.equal("response_format" in body, false);
});

test("OpenAI supports non-strict schemas that Krelvan validates after generation", async () => {
  let body: Record<string, unknown> = {};
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({
      status: "completed",
      output: [{ type: "message", content: [{ type: "output_text", text: "{\"answer\":\"ok\"}" }] }],
      usage: { input_tokens: 1, output_tokens: 1 },
    }), { status: 200 });
  }) as typeof fetch;

  const client = makeLLMClient({ provider: "openai", apiKey: "sk-test", fetchImpl });
  await client.complete({
    ...REQUEST,
    schema: {
      name: "optional_answer",
      strict: false,
      schema: { type: "object", properties: { answer: { type: "string" } } },
    },
  });

  assert.equal(
    ((body["text"] as { format: { strict: boolean } }).format.strict),
    false,
  );
});

test("OpenAI embeddings stay on the embeddings endpoint", async () => {
  let seenUrl = "";
  const fetchImpl = (async (url: string | URL | Request) => {
    seenUrl = String(url);
    return new Response(JSON.stringify({
      data: [{ embedding: [0, 1] }, { embedding: [1, 0] }],
      usage: { prompt_tokens: 3 },
    }), { status: 200 });
  }) as typeof fetch;

  const client = makeLLMClient({ provider: "openai", apiKey: "sk-test", fetchImpl });
  assert.ok(client.embed);
  const result = await client.embed(["a", "b"], "text-embedding-3-small");

  assert.equal(seenUrl, "https://api.openai.com/v1/embeddings");
  assert.deepEqual(result, { vectors: [[0, 1], [1, 0]], inputTokens: 3 });
});

test("OpenAI accepts the standard OPENAI_API_KEY fallback without borrowing another provider key", () => {
  const previous = {
    shared: process.env["KRELVAN_LLM_API_KEY"],
    openai: process.env["OPENAI_API_KEY"],
    anthropic: process.env["KRELVAN_ANTHROPIC_KEY"],
  };
  try {
    delete process.env["KRELVAN_LLM_API_KEY"];
    process.env["OPENAI_API_KEY"] = "sk-openai";
    process.env["KRELVAN_ANTHROPIC_KEY"] = "sk-anthropic";
    assert.equal(resolveProviderApiKey("openai"), "sk-openai");
    assert.equal(resolveProviderApiKey("anthropic"), "sk-anthropic");
    assert.equal(resolveProviderApiKey("gemini"), "");
  } finally {
    if (previous.shared === undefined) delete process.env["KRELVAN_LLM_API_KEY"];
    else process.env["KRELVAN_LLM_API_KEY"] = previous.shared;
    if (previous.openai === undefined) delete process.env["OPENAI_API_KEY"];
    else process.env["OPENAI_API_KEY"] = previous.openai;
    if (previous.anthropic === undefined) delete process.env["KRELVAN_ANTHROPIC_KEY"];
    else process.env["KRELVAN_ANTHROPIC_KEY"] = previous.anthropic;
  }
});

test("OpenAI empty or refused responses fail loudly", async () => {
  const fetchImpl = (async () => new Response(JSON.stringify({
    status: "completed",
    output: [{
      type: "message",
      content: [{ type: "refusal", refusal: "not available" }],
    }],
    usage: { input_tokens: 4, output_tokens: 0 },
  }), { status: 200 })) as typeof fetch;

  const client = makeLLMClient({ provider: "openai", apiKey: "sk-test", fetchImpl });
  await assert.rejects(() => client.complete(REQUEST), /refused.*not available/i);
});

test("the natural-language compiler works through the OpenAI Responses adapter", async () => {
  let seenUrl = "";
  let seenBody: Record<string, unknown> = {};
  const manifest = {
    version: 1,
    name: "calculator",
    intent: "calculate",
    entry: "calculate",
    runBudgetCents: 100,
    maxNodeVisits: 3,
    nodes: [{
      id: "calculate",
      role: "Calculate the exact result. Output object keys: body, title.",
      autonomy: "full",
      capabilities: [{ name: "think", sideEffect: "read", budgetCents: 50 }],
    }],
    edges: [],
    seed: { output_map: "title=calculate.title,body=calculate.body,format=markdown" },
  };
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    seenUrl = String(url);
    seenBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({
      status: "completed",
      output: [{
        type: "message",
        content: [{ type: "output_text", text: JSON.stringify(manifest) }],
      }],
      usage: { input_tokens: 20, output_tokens: 30 },
    }), { status: 200 });
  }) as typeof fetch;

  const model = new AnthropicModel({
    apiKey: "sk-test",
    model: "gpt-5.6-sol",
    allowedCapabilities: [{
      name: "think",
      sideEffect: "read",
      description: "Reason about local data.",
      useWhen: "calculation and analysis",
    }],
    suggestedRunBudgetCents: 1000,
    llmConfig: { provider: "openai", apiKey: "sk-test", fetchImpl },
  });
  const proposal = await model.propose("Calculate 17 multiplied by 23.");

  assert.equal(seenUrl, "https://api.openai.com/v1/responses");
  assert.equal(
    ((seenBody["text"] as { format: { strict: boolean } }).format.strict),
    false,
  );
  assert.equal(proposal.nodes[0]?.capabilities[0]?.name, "think");
  assert.equal(proposal.entry, "calculate");
});
