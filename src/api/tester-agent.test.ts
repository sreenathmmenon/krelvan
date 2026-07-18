import { test } from "node:test";
import assert from "node:assert/strict";

import { buildTesterManifest } from "./tester-agent.js";
import { validateManifest, fatalIssues } from "../core/manifest/manifest.js";

const TARGET = { id: "sha256:abc123", name: "Support Resolution Agent", intent: "Resolve a customer support ticket." };

test("buildTesterManifest: emits the full cast → delegate → judge → report chain", () => {
  const m = buildTesterManifest(TARGET);
  const nodeCaps = m.nodes.map((n) => n.capabilities.map((c) => c.name).join(","));
  assert.deepEqual(m.nodes.map((n) => n.id), ["cast", "run", "judge", "report"]);
  assert.deepEqual(nodeCaps, ["synthetic_users", "delegate", "think", "compose"]);
  assert.equal(m.entry, "cast");
  assert.deepEqual(m.edges.map((e) => `${e.from}->${e.to}`), ["cast->run", "run->judge", "judge->report"]);
});

test("buildTesterManifest: pins the target agentId in the seed (agent-tests-agent)", () => {
  const m = buildTesterManifest(TARGET);
  assert.equal((m.seed as Record<string, unknown>)["agentId"], "sha256:abc123");
  // output_map delivers the report as the artifact
  assert.equal((m.seed as Record<string, unknown>)["output_map"], "title=report.title,body=report.body,format=markdown");
});

test("buildTesterManifest: is structurally valid (passes manifest validation)", () => {
  const m = buildTesterManifest(TARGET);
  assert.deepEqual(fatalIssues(validateManifest(m)), [], "no fatal validation issues");
});

test("buildTesterManifest: honors a custom count in the seed", () => {
  const m = buildTesterManifest(TARGET, 8);
  assert.equal((m.seed as Record<string, unknown>)["count"], 8);
});
