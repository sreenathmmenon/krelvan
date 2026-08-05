import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Manifest } from "../core/manifest/manifest.js";
import type { AuthState } from "./auth.js";
import { KrelvanRuntime } from "./runtime.js";
import { createApiServer } from "./server.js";

const TOKEN = "delivery-route-token";
const authState: AuthState = {
  tokenHash: createHash("sha256").update(TOKEN, "utf8").digest("hex"),
  generated: false,
};
const headers = { Authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };

const manifest: Manifest = {
  version: 1,
  name: "Delivery security test",
  intent: "produce a result",
  entry: "done",
  runBudgetCents: 10,
  maxNodeVisits: 1,
  seed: {},
  nodes: [{ id: "done", role: "finish", autonomy: "full", capabilities: [] }],
  edges: [],
};

test("delivery webhook credentials are encrypted, masked, retained, and removable", async () => {
  const dir = mkdtempSync(join(tmpdir(), "krelvan-delivery-route-"));
  const dataDir = join(dir, "data");
  const rt = new KrelvanRuntime({ port: 0, dataDir, capabilitiesDir: join(dir, "capabilities") });
  const imported = rt.importManifest(manifest);
  assert.ok(imported.ok, imported.ok ? "" : JSON.stringify(imported.issues));
  const agentId = imported.agent.id;
  const server = createApiServer(rt, authState);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const credentialUrl = "https://example.com/hook/unguessable?token=plaintext-marker";

  try {
    const put = await fetch(`${base}/api/agents/${encodeURIComponent(agentId)}/delivery`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ deliverTo: [{ channel: "inbox" }, { channel: "webhook", config: { url: credentialUrl } }] }),
    });
    assert.equal(put.status, 200);
    const putBody = await put.json() as { deliverTo: Array<{ channel: string; config?: Record<string, unknown> }> };
    const returned = putBody.deliverTo.find((target) => target.channel === "webhook");
    assert.deepEqual(returned?.config, { url_saved: true }, "write response returns no credential or secret reference");

    const stored = rt.agentRegistry.get(agentId)?.deliverTo?.find((target) => target.channel === "webhook");
    const ref = stored?.config?.["url_ref"];
    assert.ok(ref?.startsWith("__delivery__."), "agent record contains only an internal encrypted-secret reference");
    assert.equal(rt.secretStore.resolve(ref!), credentialUrl, "reference resolves only inside the server");
    assert.ok(!rt.secretStore.list().some((secret) => secret.name === ref), "internal delivery secret is hidden from Secrets UI");
    assert.ok(!readFileSync(join(dataDir, "agents.json"), "utf8").includes("plaintext-marker"), "plaintext URL is absent from the persisted agent record");

    const get = await fetch(`${base}/api/agents/${encodeURIComponent(agentId)}/delivery`, { headers });
    const getText = await get.text();
    assert.ok(!getText.includes("unguessable") && !getText.includes("__delivery__"), "read response leaks neither value nor reference");
    assert.deepEqual((JSON.parse(getText) as { deliverTo: Array<{ channel: string; config?: Record<string, unknown> }> }).deliverTo
      .find((target) => target.channel === "webhook")?.config, { url_saved: true });

    // This is what the masked UI sends when the operator clicks Save without replacing the URL.
    const retain = await fetch(`${base}/api/agents/${encodeURIComponent(agentId)}/delivery`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ deliverTo: [{ channel: "inbox" }, { channel: "webhook" }] }),
    });
    assert.equal(retain.status, 200);
    assert.equal(rt.agentRegistry.get(agentId)?.deliverTo?.find((target) => target.channel === "webhook")?.config?.["url_ref"], ref);

    const disable = await fetch(`${base}/api/agents/${encodeURIComponent(agentId)}/delivery`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ deliverTo: [{ channel: "inbox" }] }),
    });
    assert.equal(disable.status, 200);
    assert.equal(rt.agentRegistry.get(agentId)?.deliverTo?.some((target) => target.channel === "webhook"), false);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});
