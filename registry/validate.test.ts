/**
 * Registry validator — runs on every PR to the marketplace. Each entry in index.json is
 * checked with the SAME pure validators the runtime uses, so a broken capability or
 * template can never reach a user's Discover tab. Zero network: structural only.
 *
 * Catches: bad YAML, invalid sideEffect, non-integer estimateCents, unsafe responseField,
 * a template manifest that doesn't validate, a template referencing an unknown capability,
 * declared/actual sideEffect drift, and missing required fields.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadYamlCapability } from "../src/core/extensions/yaml-capability.js";
import { validateManifest, type Manifest } from "../src/core/manifest/manifest.js";

const here = dirname(fileURLToPath(import.meta.url));
const index = JSON.parse(readFileSync(join(here, "index.json"), "utf8")) as {
  version: number; capabilities: RegistryEntry[];
};

interface RegistryEntry {
  name: string; title: string; oneLiner: string; category: string; sideEffect: string;
  tier: string; author: string; kind: string; secretRefs?: string[];
  yaml?: string; mcp?: McpBlock; manifest?: Manifest; capabilities?: { name: string; yaml: string }[];
  connectors?: string[]; // pack kind
}
interface McpBlock { name?: string; command?: string; args?: string[]; url?: string; env?: Record<string, string>; tools?: string[]; defaultSideEffect?: string }

const SIDE_EFFECTS = new Set(["read", "write-reversible", "write-irreversible", "spend", "message-human", "identity-mutation"]);
const BUILTINS = new Set(["think", "llm_route", "compose", "recall", "remember", "identify", "web_search", "http_get", "http_post", "notify_webhook", "text_transform", "email_send", "telegram_send", "slack_send", "rag.ingest", "rag.search", "wiki.ingest", "wiki.query"]);

test("registry index.json has the expected envelope", () => {
  assert.equal(index.version, 1);
  assert.ok(Array.isArray(index.capabilities) && index.capabilities.length > 0);
});

test("every registry entry has the required fields + a valid sideEffect/tier/kind", () => {
  for (const e of index.capabilities) {
    for (const f of ["name", "title", "oneLiner", "category", "sideEffect", "tier", "author", "kind"] as const) {
      assert.ok(e[f], `entry '${e.name ?? "?"}' is missing required field '${f}'`);
    }
    assert.ok(SIDE_EFFECTS.has(e.sideEffect), `entry '${e.name}' has invalid sideEffect '${e.sideEffect}'`);
    assert.ok(["official", "community"].includes(e.tier), `entry '${e.name}' has invalid tier '${e.tier}'`);
    assert.ok(["yaml", "mcp", "template", "pack"].includes(e.kind), `entry '${e.name}' has invalid kind '${e.kind}'`);
    assert.match(e.name, /^[a-z][a-z0-9._-]*$/, `entry name '${e.name}' is not a valid machine name`);
  }
});

test("every mcp entry declares env secrets as {{secret:}} refs (no inlined tokens) and lists them in secretRefs", () => {
  const SECRET_RE = /\{\{secret:([a-zA-Z0-9_.-]+)\}\}/g;
  for (const e of index.capabilities.filter(x => x.kind === "mcp")) {
    const env = e.mcp?.env ?? {};
    const args = e.mcp?.args ?? [];
    const declared = new Set(e.secretRefs ?? []);
    // Collect every secret ref used anywhere in env values or args.
    const used = new Set<string>();
    for (const v of [...Object.values(env), ...args]) {
      for (const m of String(v).matchAll(SECRET_RE)) if (m[1]) used.add(m[1]);
    }
    for (const ref of used) {
      assert.ok(declared.has(ref), `mcp '${e.name}' uses {{secret:${ref}}} but does not list it in secretRefs`);
    }
    // No raw-looking credential inlined directly in env/args (must be a {{secret:}} ref).
    for (const [k, v] of Object.entries(env)) {
      if (/token|key|secret|password|api/i.test(k) && !/\{\{secret:/.test(String(v)) && String(v).trim() !== "") {
        assert.fail(`mcp '${e.name}' env '${k}' looks like a credential but is inlined, not a {{secret:}} ref`);
      }
    }
  }
});

test("every pack references only connectors that exist in the registry", () => {
  const names = new Set(index.capabilities.map(e => e.name));
  for (const e of index.capabilities.filter(x => x.kind === "pack")) {
    assert.ok(Array.isArray(e.connectors) && e.connectors.length > 0, `pack '${e.name}' must list connectors`);
    for (const c of e.connectors!) {
      assert.ok(names.has(c), `pack '${e.name}' references unknown connector '${c}'`);
    }
  }
});

test("every yaml entry compiles + its declared sideEffect matches the YAML", () => {
  for (const e of index.capabilities.filter(x => x.kind === "yaml")) {
    assert.ok(e.yaml, `yaml entry '${e.name}' has no inline yaml`);
    const r = loadYamlCapability(e.yaml!, () => undefined);
    assert.ok(r.ok, `yaml entry '${e.name}' failed to compile: ${!r.ok ? JSON.stringify(r.error) : ""}`);
    assert.equal(r.plugin.name, e.name, `yaml entry name '${e.name}' != compiled plugin name '${r.plugin.name}'`);
    assert.equal(r.plugin.sideEffect, e.sideEffect, `entry '${e.name}' declares sideEffect '${e.sideEffect}' but YAML says '${r.plugin.sideEffect}'`);
  }
});

test("every mcp entry declares a connection config", () => {
  for (const e of index.capabilities.filter(x => x.kind === "mcp")) {
    assert.ok(e.mcp && typeof e.mcp === "object", `mcp entry '${e.name}' has no mcp config`);
  }
});

test("every template entry has a VALID manifest using known capabilities + bundles its yaml caps", () => {
  for (const e of index.capabilities.filter(x => x.kind === "template")) {
    assert.ok(e.manifest, `template '${e.name}' has no manifest`);
    const issues = validateManifest(e.manifest!);
    assert.deepEqual(issues, [], `template '${e.name}' manifest invalid: ${issues.map(i => i.message).join("; ")}`);

    // The capabilities each node uses must be a built-in OR bundled with the template.
    const bundled = new Set((e.capabilities ?? []).map(c => c.name));
    for (const node of e.manifest!.nodes) {
      for (const cap of node.capabilities) {
        assert.ok(
          BUILTINS.has(cap.name) || bundled.has(cap.name),
          `template '${e.name}' node '${node.id}' uses '${cap.name}' which is neither a built-in nor bundled`,
        );
      }
    }
    // Each bundled capability must itself compile.
    for (const cap of e.capabilities ?? []) {
      const r = loadYamlCapability(cap.yaml, () => undefined);
      assert.ok(r.ok, `template '${e.name}' bundled capability '${cap.name}' failed to compile`);
    }
  }
});
