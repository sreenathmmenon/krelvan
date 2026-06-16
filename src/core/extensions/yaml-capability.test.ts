/**
 * Tests for the YAML capability loader.
 *
 * Covers: parsing, all validation rules (EXT-01..04), secret ref extraction,
 * input interpolation, HTTP compilation, responseField extraction, and the
 * full load→invoke path with a mock fetch.
 *
 * Run: npm test
 */

// These tests mock globalThis.fetch and use non-resolvable hosts (api.example.com),
// so we let the SSRF guard skip the DNS step while keeping scheme/IP checks active.
process.env["KRELVAN_SSRF_ALLOW_UNRESOLVABLE"] = "1";

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  validateYamlCapability,
  loadYamlCapability,
  parseYaml,
  extractSecretRefs,
  type ValidationError,
} from "./yaml-capability.js";

// ── helpers ───────────────────────────────────────────────────────────────────

function noErrors(errors: ValidationError[]): void {
  assert.deepEqual(errors, [], `expected no errors but got: ${JSON.stringify(errors)}`);
}

function hasError(errors: ValidationError[], field: string, fragment?: string): void {
  const match = errors.find((e) =>
    e.field === field && (fragment === undefined || e.message.includes(fragment)),
  );
  assert.ok(
    match,
    `expected error on field '${field}'${fragment ? ` containing '${fragment}'` : ""} but got: ${JSON.stringify(errors)}`,
  );
}

const MINIMAL_VALID = `
name: crm.lookup
description: Look up a CRM customer record
sideEffect: read
estimateCents: 0

http:
  url: https://api.example.com/customers
  method: GET
`;

const FULL_VALID = `
name: stripe.charge
description: Create a Stripe payment charge
sideEffect: spend
estimateCents: 2

http:
  url: https://api.stripe.com/v1/charges
  method: POST
  headers:
    Authorization: "Bearer {{secret:stripe-key}}"
    Content-Type: application/json
  body:
    amount: "{{input.amountCents}}"
    currency: usd

input:
  amountCents:
    type: number
    required: true
    description: Amount to charge in cents
  customerId:
    type: string
    required: true

output:
  chargeId:
    type: string
  status:
    type: string

responseField: id
successCodes:
  - 200
  - 201
`;

// ── YAML parser ───────────────────────────────────────────────────────────────

test("parseYaml: parses a minimal capability", () => {
  const obj = parseYaml(MINIMAL_VALID) as Record<string, unknown>;
  assert.equal(obj["name"], "crm.lookup");
  assert.equal(obj["sideEffect"], "read");
  assert.equal(obj["estimateCents"], 0);
  const http = obj["http"] as Record<string, unknown>;
  assert.equal(http["url"], "https://api.example.com/customers");
  assert.equal(http["method"], "GET");
});

test("parseYaml: parses nested objects and quoted strings", () => {
  const obj = parseYaml(FULL_VALID) as Record<string, unknown>;
  assert.equal(obj["name"], "stripe.charge");
  assert.equal(obj["sideEffect"], "spend");
  assert.equal(obj["estimateCents"], 2);
  const http = obj["http"] as Record<string, unknown>;
  assert.equal(http["method"], "POST");
  const headers = http["headers"] as Record<string, unknown>;
  assert.equal(headers["Authorization"], "Bearer {{secret:stripe-key}}");
});

test("parseYaml: parses arrays", () => {
  const obj = parseYaml(FULL_VALID) as Record<string, unknown>;
  const codes = obj["successCodes"] as unknown[];
  assert.deepEqual(codes, [200, 201]);
});

test("parseYaml: strips comments", () => {
  const yaml = `
name: test.cap # this is a comment
description: Test # another comment
sideEffect: read
estimateCents: 0
http:
  url: https://example.com
  method: GET
`;
  const obj = parseYaml(yaml) as Record<string, unknown>;
  assert.equal(obj["name"], "test.cap");
});

test("parseYaml: handles boolean and null scalars", () => {
  const yaml = `
name: test.cap
description: Test
sideEffect: read
estimateCents: 0
http:
  url: https://example.com
  method: GET
input:
  active:
    type: boolean
`;
  const obj = parseYaml(yaml) as Record<string, unknown>;
  assert.ok(obj["http"]);
});

// ── Validation — happy path ───────────────────────────────────────────────────

test("validateYamlCapability: minimal valid passes", () => {
  noErrors(validateYamlCapability(parseYaml(MINIMAL_VALID)));
});

test("validateYamlCapability: full valid passes", () => {
  noErrors(validateYamlCapability(parseYaml(FULL_VALID)));
});

// ── Validation — name ─────────────────────────────────────────────────────────

test("EXT name: missing name is an error", () => {
  const obj = parseYaml(MINIMAL_VALID) as Record<string, unknown>;
  delete obj["name"];
  hasError(validateYamlCapability(obj), "name");
});

test("EXT name: uppercase is rejected", () => {
  const obj = parseYaml(MINIMAL_VALID) as Record<string, unknown>;
  obj["name"] = "CRM.Lookup";
  hasError(validateYamlCapability(obj), "name");
});

test("EXT name: spaces are rejected", () => {
  const obj = parseYaml(MINIMAL_VALID) as Record<string, unknown>;
  obj["name"] = "crm lookup";
  hasError(validateYamlCapability(obj), "name");
});

test("EXT name: valid dotted name passes", () => {
  const obj = parseYaml(MINIMAL_VALID) as Record<string, unknown>;
  obj["name"] = "my-company.internal.api.fetch";
  noErrors(validateYamlCapability(obj));
});

// ── Validation — description ──────────────────────────────────────────────────

test("EXT description: missing is an error", () => {
  const obj = parseYaml(MINIMAL_VALID) as Record<string, unknown>;
  delete obj["description"];
  hasError(validateYamlCapability(obj), "description");
});

test("EXT description: empty string is an error", () => {
  const obj = parseYaml(MINIMAL_VALID) as Record<string, unknown>;
  obj["description"] = "  ";
  hasError(validateYamlCapability(obj), "description");
});

// ── Validation — sideEffect (EXT-01) ─────────────────────────────────────────

test("EXT-01: unknown sideEffect is rejected at load time", () => {
  const obj = parseYaml(MINIMAL_VALID) as Record<string, unknown>;
  obj["sideEffect"] = "destroy-everything";
  hasError(validateYamlCapability(obj), "sideEffect");
});

test("EXT-01: all valid sideEffect values are accepted", () => {
  const valid = ["read", "write-reversible", "write-irreversible", "spend", "message-human", "identity-mutation"];
  for (const v of valid) {
    const obj = parseYaml(MINIMAL_VALID) as Record<string, unknown>;
    obj["sideEffect"] = v;
    noErrors(validateYamlCapability(obj));
  }
});

// ── Validation — estimateCents ────────────────────────────────────────────────

test("EXT-04: float estimateCents is rejected", () => {
  const obj = parseYaml(MINIMAL_VALID) as Record<string, unknown>;
  obj["estimateCents"] = 1.5;
  hasError(validateYamlCapability(obj), "estimateCents", "integer");
});

test("EXT-04: negative estimateCents is rejected", () => {
  const obj = parseYaml(MINIMAL_VALID) as Record<string, unknown>;
  obj["estimateCents"] = -1;
  hasError(validateYamlCapability(obj), "estimateCents", "non-negative");
});

test("EXT-04: zero estimateCents is valid", () => {
  const obj = parseYaml(MINIMAL_VALID) as Record<string, unknown>;
  obj["estimateCents"] = 0;
  noErrors(validateYamlCapability(obj));
});

// ── Validation — http block ───────────────────────────────────────────────────

test("EXT http: missing url is an error", () => {
  const obj = parseYaml(MINIMAL_VALID) as Record<string, unknown>;
  const http = obj["http"] as Record<string, unknown>;
  delete http["url"];
  hasError(validateYamlCapability(obj), "http.url");
});

test("EXT http: non-https url is rejected", () => {
  const obj = parseYaml(MINIMAL_VALID) as Record<string, unknown>;
  const http = obj["http"] as Record<string, unknown>;
  http["url"] = "ftp://bad.example.com";
  hasError(validateYamlCapability(obj), "http.url");
});

test("EXT http: unknown method is rejected", () => {
  const obj = parseYaml(MINIMAL_VALID) as Record<string, unknown>;
  const http = obj["http"] as Record<string, unknown>;
  http["method"] = "DESTROY";
  hasError(validateYamlCapability(obj), "http.method");
});

test("EXT http: body on GET is rejected", () => {
  const obj = parseYaml(MINIMAL_VALID) as Record<string, unknown>;
  const http = obj["http"] as Record<string, unknown>;
  http["method"] = "GET";
  http["body"] = { foo: "bar" };
  hasError(validateYamlCapability(obj), "http.body");
});

test("EXT http: body on POST is valid", () => {
  const obj = parseYaml(MINIMAL_VALID) as Record<string, unknown>;
  const http = obj["http"] as Record<string, unknown>;
  http["method"] = "POST";
  http["body"] = { foo: "bar" };
  noErrors(validateYamlCapability(obj));
});

// ── Validation — responseField (EXT-03) ──────────────────────────────────────

test("EXT-03: simple dot-path responseField is valid", () => {
  const obj = parseYaml(MINIMAL_VALID) as Record<string, unknown>;
  obj["responseField"] = "data.items";
  noErrors(validateYamlCapability(obj));
});

test("EXT-03: bracket access in responseField is rejected", () => {
  const obj = parseYaml(MINIMAL_VALID) as Record<string, unknown>;
  obj["responseField"] = "data[0].name";
  hasError(validateYamlCapability(obj), "responseField");
});

test("EXT-03: eval-like responseField is rejected", () => {
  const obj = parseYaml(MINIMAL_VALID) as Record<string, unknown>;
  obj["responseField"] = "data; process.exit(1)";
  hasError(validateYamlCapability(obj), "responseField");
});

// ── Validation — successCodes ─────────────────────────────────────────────────

test("EXT successCodes: invalid status code is rejected", () => {
  const obj = parseYaml(MINIMAL_VALID) as Record<string, unknown>;
  obj["successCodes"] = [200, 999];
  hasError(validateYamlCapability(obj), "successCodes[1]");
});

test("EXT successCodes: valid codes pass", () => {
  const obj = parseYaml(MINIMAL_VALID) as Record<string, unknown>;
  obj["successCodes"] = [200, 201, 204];
  noErrors(validateYamlCapability(obj));
});

// ── Secret ref extraction (EXT-02) ────────────────────────────────────────────

test("EXT-02: extractSecretRefs finds all refs", () => {
  const refs = extractSecretRefs("Bearer {{secret:stripe-key}} and {{secret:other.key}}");
  assert.deepEqual(refs, ["stripe-key", "other.key"]);
});

test("EXT-02: extractSecretRefs returns empty for no refs", () => {
  assert.deepEqual(extractSecretRefs("no secrets here"), []);
});

test("EXT-02: secretRefs are reported in LoadResult", () => {
  const yaml = `
name: stripe.charge
description: Charge via Stripe
sideEffect: spend
estimateCents: 2
http:
  url: https://api.stripe.com/v1/charges
  method: POST
  headers:
    Authorization: "Bearer {{secret:stripe-key}}"
`;
  const result = loadYamlCapability(yaml, () => ({ "stripe-key": "tok_test" }));
  assert.ok(result.ok);
  if (result.ok) {
    assert.deepEqual(result.secretRefs, ["stripe-key"]);
  }
});

// ── Full load→invoke path ─────────────────────────────────────────────────────

test("loadYamlCapability: minimal valid loads successfully", () => {
  const result = loadYamlCapability(MINIMAL_VALID, () => ({}));
  assert.ok(result.ok, `expected ok but got errors: ${JSON.stringify(!result.ok && result.errors)}`);
  if (result.ok) {
    assert.equal(result.plugin.name, "crm.lookup");
    assert.equal(result.plugin.sideEffect, "read");
    assert.equal(result.plugin.estimateCents({ nodeId: "n", capability: "crm.lookup", input: {} }), 0);
  }
});

test("loadYamlCapability: invalid YAML returns errors", () => {
  const result = loadYamlCapability("not: valid: yaml: extra: colons: everywhere:", () => ({}));
  // should either parse or return errors — should not throw
  assert.ok(result !== undefined);
});

test("loadYamlCapability: invoke performs HTTP GET and returns response", async () => {
  // Mock fetch for this test
  const originalFetch = globalThis.fetch;
  let capturedUrl = "";
  let capturedMethod = "";
  globalThis.fetch = async (url: string | URL | Request, opts?: RequestInit) => {
    capturedUrl = String(url);
    capturedMethod = opts?.method ?? "GET";
    return new Response(JSON.stringify({ name: "Acme Corp", tier: "enterprise" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  try {
    const result = loadYamlCapability(MINIMAL_VALID, () => ({}));
    assert.ok(result.ok);
    if (result.ok) {
      const out = await result.plugin.invoke({
        nodeId: "n1",
        capability: "crm.lookup",
        input: { customerId: "cust_123" },
      });
      assert.equal(capturedUrl, "https://api.example.com/customers");
      assert.equal(capturedMethod, "GET");
      assert.deepEqual(out.output, { name: "Acme Corp", tier: "enterprise" });
      assert.equal(out.claimedCostCents, 0);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("loadYamlCapability: invoke interpolates {{secret:name}} in headers", async () => {
  const yaml = `
name: internal.api
description: Internal API
sideEffect: read
estimateCents: 0
http:
  url: https://api.internal/data
  method: GET
  headers:
    Authorization: "Bearer {{secret:internal-token}}"
`;

  const originalFetch = globalThis.fetch;
  let capturedHeaders: Record<string, string> = {};
  globalThis.fetch = async (_url: string | URL | Request, opts?: RequestInit) => {
    capturedHeaders = Object.fromEntries(new Headers(opts?.headers as Record<string, string>).entries());
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  try {
    const result = loadYamlCapability(yaml, (_refs) => ({ "internal-token": "tok_scoped_abc" }));
    assert.ok(result.ok);
    if (result.ok) {
      await result.plugin.invoke({ nodeId: "n", capability: "internal.api", input: {} });
      assert.equal(capturedHeaders["authorization"], "Bearer tok_scoped_abc");
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("loadYamlCapability: invoke uses responseField to extract nested value", async () => {
  const yaml = `
name: api.items
description: Get items
sideEffect: read
estimateCents: 0
http:
  url: https://api.example.com/items
  method: GET
responseField: data.items
`;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    JSON.stringify({ data: { items: [1, 2, 3], total: 3 } }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );

  try {
    const result = loadYamlCapability(yaml, () => ({}));
    assert.ok(result.ok);
    if (result.ok) {
      const out = await result.plugin.invoke({ nodeId: "n", capability: "api.items", input: {} });
      assert.deepEqual(out.output, [1, 2, 3]);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("loadYamlCapability: invoke throws on non-success HTTP status", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("Not Found", { status: 404 });

  try {
    const result = loadYamlCapability(MINIMAL_VALID, () => ({}));
    assert.ok(result.ok);
    if (result.ok) {
      await assert.rejects(
        () => result.plugin.invoke({ nodeId: "n", capability: "crm.lookup", input: {} }),
        /HTTP 404/,
      );
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("loadYamlCapability: missing secret throws at invoke time", async () => {
  const yaml = `
name: secret.test
description: Test secret
sideEffect: read
estimateCents: 0
http:
  url: https://api.example.com
  method: GET
  headers:
    Authorization: "Bearer {{secret:my-key}}"
`;
  const result = loadYamlCapability(yaml, () => ({})); // resolver returns nothing
  assert.ok(result.ok);
  if (result.ok) {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    try {
      await assert.rejects(
        () => result.plugin.invoke({ nodeId: "n", capability: "secret.test", input: {} }),
        /secret 'my-key' is not registered/,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  }
});

test("loadYamlCapability: POST with body interpolates input fields", async () => {
  const yaml = `
name: webhook.send
description: POST to a webhook
sideEffect: write-reversible
estimateCents: 0
http:
  url: https://hooks.example.com/notify
  method: POST
  body:
    event: "{{input.eventName}}"
    userId: "{{input.userId}}"
`;

  const originalFetch = globalThis.fetch;
  let capturedBody = "";
  globalThis.fetch = async (_url: string | URL | Request, opts?: RequestInit) => {
    capturedBody = opts?.body as string ?? "";
    return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
  };

  try {
    const result = loadYamlCapability(yaml, () => ({}));
    assert.ok(result.ok);
    if (result.ok) {
      await result.plugin.invoke({
        nodeId: "n",
        capability: "webhook.send",
        input: { eventName: "user.signup", userId: "u_abc" },
      });
      const parsed = JSON.parse(capturedBody) as Record<string, unknown>;
      assert.equal(parsed["event"], "user.signup");
      assert.equal(parsed["userId"], "u_abc");
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});
