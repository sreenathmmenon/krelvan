#!/usr/bin/env node
/**
 * krelvan-plugin — the connector-authoring CLI (the flywheel on-ramp).
 *
 *   krelvan-plugin new <name> --kind yaml|mcp   # scaffold a connector
 *   krelvan-plugin check <file.yaml|entry.json> # pre-publish lint (secret-scan + shape)
 *
 * Node built-ins only. The `check` command runs the SAME validators the registry CI uses,
 * so an author catches inlined-secret / bad-shape problems before opening a PR.
 */

import { writeFileSync, existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const [, , cmd, ...rest] = process.argv;

function arg(name, def) {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 && rest[i + 1] ? rest[i + 1] : def;
}

const YAML_TEMPLATE = (name) => `name: ${name}
description: One sentence on what this connector does.
# read | write-reversible | write-irreversible | spend | message-human | identity-mutation
sideEffect: read
estimateCents: 1
http:
  url: "https://api.example.com/v1/thing"
  method: GET
  headers:
    Authorization: "Bearer {{secret:${name.toUpperCase().replace(/[.\-]/g, "_")}_API_KEY}}"
  # body is allowed on POST/PUT/PATCH (JSON only); inputs as {{input.field}}
input:
  query: { type: string, required: true, description: "What the caller passes in." }
# optional: extract one dot-path from the JSON response
responseField: data
successCodes: [200]
`;

const MCP_TEMPLATE = (name) => JSON.stringify({
  name, title: name, oneLiner: "One sentence on what this connector does.",
  category: "Connectors", sideEffect: "read", tier: "community", author: "you", kind: "mcp",
  secretRefs: [`${name.toUpperCase()}_API_KEY`],
  sourceUrl: "https://github.com/you/your-mcp-server",
  mcp: {
    name, command: "npx", args: ["-y", "your-mcp-server"],
    // {{secret:NAME}} is resolved from the secret store into the child env (never inlined).
    env: { [`${name.toUpperCase()}_API_KEY`]: `{{secret:${name.toUpperCase()}_API_KEY}}` },
    defaultSideEffect: "read",
  },
}, null, 2) + "\n";

function scaffold() {
  const name = rest.find((r) => !r.startsWith("--"));
  if (!name) { console.error("usage: krelvan-plugin new <name> --kind yaml|mcp"); process.exit(1); }
  if (!/^[a-z][a-z0-9._-]*$/.test(name)) { console.error(`invalid name '${name}' — must match [a-z][a-z0-9._-]*`); process.exit(1); }
  const kind = arg("kind", "yaml");
  const file = kind === "mcp" ? `${name}.mcp.json` : `${name}.yaml`;
  if (existsSync(file)) { console.error(`refusing to overwrite ${file}`); process.exit(1); }
  writeFileSync(file, kind === "mcp" ? MCP_TEMPLATE(name) : YAML_TEMPLATE(name));
  console.log(`✓ created ${file}`);
  console.log(`  next: edit it, then  krelvan-plugin check ${file}`);
  console.log(`  publish: add it to your krelvan-registry fork's index.json and open a PR.`);
}

// ── check: secret-scan + shape ──────────────────────────────────────────────
const SECRET_RE = /\{\{secret:([a-zA-Z0-9_.-]+)\}\}/g;
// Things that look like REAL credentials inlined (must be {{secret:}} refs instead).
const LEAK_RE = /(sk-[a-zA-Z0-9]{16,}|ghp_[a-zA-Z0-9]{20,}|xox[bp]-[a-zA-Z0-9-]{10,}|AIza[a-zA-Z0-9_-]{20,}|fc-[a-zA-Z0-9]{16,}|-----BEGIN [A-Z ]*PRIVATE KEY)/;

function check() {
  const file = rest.find((r) => !r.startsWith("--"));
  if (!file || !existsSync(file)) { console.error(`usage: krelvan-plugin check <file>`); process.exit(1); }
  const text = readFileSync(file, "utf8");
  const problems = [];

  // 1) Secret-scan — no inlined credentials, ever.
  const leak = text.match(LEAK_RE);
  if (leak) problems.push(`inlined credential detected ("${leak[0].slice(0, 12)}…") — use {{secret:NAME}} instead`);

  // 2) Shape — YAML compiles through the shipped loader OR MCP json parses.
  if (file.endsWith(".yaml") || file.endsWith(".yml")) {
    const loaderUrl = new URL("../dist/core/extensions/yaml-capability.js", import.meta.url).href;
    const r = spawnSync(process.execPath, ["--input-type=module", "-e",
      `import {loadYamlCapability} from ${JSON.stringify(loaderUrl)};` +
      `import {readFileSync} from "node:fs";` +
      `const out=loadYamlCapability(readFileSync(${JSON.stringify(file)},"utf8"),()=>undefined);` +
      `if(!out.ok){console.error("YAML_ERROR "+JSON.stringify(out.error??out));process.exit(2);}` +
      `else console.log("OK "+out.plugin.name+" sideEffect="+out.plugin.sideEffect+" secretRefs="+JSON.stringify(out.secretRefs));`,
    ], { encoding: "utf8" });
    if (r.status !== 0) problems.push(`YAML does not compile: ${(r.stderr || r.stdout || "").trim().slice(0, 200)}`);
    else console.log(`  ${r.stdout.trim()}`);
  } else if (file.endsWith(".json")) {
    let e;
    try { e = JSON.parse(text); } catch { problems.push("not valid JSON"); }
    if (e) {
      for (const f of ["name", "kind", "sideEffect"]) if (!e[f]) problems.push(`missing required field '${f}'`);
      // every {{secret:}} used must be declared in secretRefs
      const used = new Set();
      for (const m of JSON.stringify(e.mcp ?? {}).matchAll(SECRET_RE)) used.add(m[1]);
      const declared = new Set(e.secretRefs ?? []);
      for (const u of used) if (!declared.has(u)) problems.push(`{{secret:${u}}} used but not in secretRefs`);
    }
  }

  if (problems.length) {
    console.error(`✗ ${file} has ${problems.length} problem(s):`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log(`✓ ${file} passed pre-publish checks (no inlined secrets, valid shape).`);
}

if (cmd === "new") scaffold();
else if (cmd === "check") check();
else {
  console.log("krelvan-plugin — author Krelvan connectors\n");
  console.log("  krelvan-plugin new <name> --kind yaml|mcp   scaffold a connector");
  console.log("  krelvan-plugin check <file>                 pre-publish lint (secret-scan + shape)");
}
