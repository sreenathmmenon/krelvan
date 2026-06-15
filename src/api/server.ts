/**
 * Krelvan HTTP API server.
 *
 * Plain Node http module — zero new runtime dependencies. Serves the UI and the
 * REST API. All state lives in the ledger (SQLite); the server is stateless between
 * requests.
 *
 * Routes:
 *   GET  /api/agents               list all agents (manifests)
 *   POST /api/agents               compile intent → save manifest (simple)
 *   POST /api/agents/build         builder-agent loop: propose → validate → self-correct (up to 3×) → return graph
 *   GET    /api/agents/:id           get a single agent
 *   DELETE /api/agents/:id           delete an agent (blocked if a run is active)
 *   GET  /api/agents/:id/runs      list runs for a specific agent
 *   GET  /api/runs                 list all runs (all tenants/agents)
 *   POST /api/runs                 start a run for an agent
 *   GET  /api/runs/:id             run summary + projection
 *   GET  /api/runs/:id/stream      SSE stream of ledger events (real-time)
 *   GET  /api/runs/:id/events      raw ledger events for a run
 *   GET  /api/runs/:id/explain     LLM plain-English explanation of what happened and why
 *   GET  /api/capabilities                       list all capability plugins (builtins + installed)
 *   POST /api/capabilities                       install: JSON {yaml,name} for YAML, or multipart for .js/.ts file
 *   PATCH /api/capabilities/:name                enable or disable: {enabled: boolean, reason?: string}
 *   POST /api/capabilities/:name/enable          enable a plugin
 *   POST /api/capabilities/:name/disable         disable a plugin (body: {reason?: string})
 *   DELETE /api/capabilities/:name               uninstall a capability
 *   GET  /api/mcp                  list connected MCP servers
 *   POST /api/mcp                  connect a new MCP server
 *   DELETE /api/mcp/:name          disconnect an MCP server
 *   GET  /api/approvals             list pending HITL approvals (all halted runs)
 *   POST /api/approvals/:id/resolve resolve a pending approval (approve or deny)
 *   GET  /api/schedules            list all schedules
 *   POST /api/schedules            create a new schedule
 *   GET  /api/schedules/:id        get a single schedule
 *   PATCH /api/schedules/:id       enable or disable a schedule
 *   DELETE /api/schedules/:id      delete a schedule
 *   GET  /api/agents/:id/memory    get agent memory (semantic facts + episodic log + soul)
 *   DELETE /api/agents/:id/memory  clear all agent memory (blocked if agent is running)
 *   GET  /api/health               liveness probe
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { getLogger } from "../core/observability/logger.js";
import type { KrelvanRuntime } from "./runtime.js";
import type { Manifest } from "../core/manifest/manifest.js";
import { getLLMClient } from "../adapters/llm-client.js";

const log = getLogger("api");

// ── tiny router ───────────────────────────────────────────────────────────────

type Handler = (req: IncomingMessage, res: ServerResponse, params: Record<string, string>) => Promise<void>;

interface Route {
  method: string;
  pattern: string[];  // split on "/", ":param" = capture
  handler: Handler;
}

function matchRoute(routes: Route[], method: string, path: string): { handler: Handler; params: Record<string, string> } | null {
  const parts = path.split("/").filter(Boolean);
  for (const route of routes) {
    if (route.method !== method && route.method !== "*") continue;
    if (route.pattern.length !== parts.length) continue;
    const params: Record<string, string> = {};
    let ok = true;
    for (let i = 0; i < route.pattern.length; i++) {
      const seg = route.pattern[i]!;
      const part = parts[i]!;
      if (seg.startsWith(":")) {
        params[seg.slice(1)] = decodeURIComponent(part);
      } else if (seg !== part) {
        ok = false;
        break;
      }
    }
    if (ok) return { handler: route.handler, params };
  }
  return null;
}

async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function readBodyBuffer(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/**
 * Minimal multipart/form-data parser — handles single-part file upload.
 * Returns { fields, file: { filename, content } | null }.
 * No third-party dependency.
 */
function parseMultipart(body: Buffer, boundary: string): {
  fields: Record<string, string>;
  file: { filename: string; content: Buffer; contentType: string } | null;
} {
  const fields: Record<string, string> = {};
  let file: { filename: string; content: Buffer; contentType: string } | null = null;

  const boundaryBuf = Buffer.from("--" + boundary);
  const sep = Buffer.from("\r\n");
  const headerEnd = Buffer.from("\r\n\r\n");

  let pos = 0;
  while (pos < body.length) {
    const bStart = indexOf(body, boundaryBuf, pos);
    if (bStart === -1) break;
    pos = bStart + boundaryBuf.length;
    if (pos + 2 > body.length) break;
    // "--" suffix = end boundary
    if (body[pos] === 45 && body[pos + 1] === 45) break;
    // skip \r\n
    pos += 2;
    const hEnd = indexOf(body, headerEnd, pos);
    if (hEnd === -1) break;
    const headers = body.subarray(pos, hEnd).toString("utf8");
    pos = hEnd + 4;
    const nextBoundary = indexOf(body, Buffer.from("\r\n--" + boundary), pos);
    const valueEnd = nextBoundary === -1 ? body.length : nextBoundary;
    const value = body.subarray(pos, valueEnd);
    pos = valueEnd;

    const cdMatch = headers.match(/Content-Disposition: form-data;([^\r\n]*)/i);
    if (!cdMatch) continue;
    const nameMatch = cdMatch[1]!.match(/name="([^"]+)"/);
    const filenameMatch = cdMatch[1]!.match(/filename="([^"]+)"/);
    const ctMatch = headers.match(/Content-Type:\s*([^\r\n]+)/i);
    const partName = nameMatch?.[1] ?? "";
    if (filenameMatch) {
      file = { filename: filenameMatch[1]!, content: value, contentType: ctMatch?.[1]?.trim() ?? "application/octet-stream" };
    } else if (partName) {
      fields[partName] = value.toString("utf8");
    }
  }
  return { fields, file };
}

function indexOf(haystack: Buffer, needle: Buffer, start = 0): number {
  for (let i = start; i <= haystack.length - needle.length; i++) {
    let found = true;
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) { found = false; break; }
    }
    if (found) return i;
  }
  return -1;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body, null, 2);
  res.writeHead(status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(data);
}

function jsonError(res: ServerResponse, status: number, message: string): void {
  json(res, status, { error: message });
}

// ── server factory ────────────────────────────────────────────────────────────

export function createApiServer(runtime: KrelvanRuntime) {
  const routes: Route[] = [
    { method: "GET",    pattern: ["api", "health"],                  handler: handleHealth },
    { method: "GET",    pattern: ["api", "agents"],                  handler: (q, r) => handleListAgents(q, r, runtime) },
    { method: "POST",   pattern: ["api", "agents"],                  handler: (q, r) => handleCreateAgent(q, r, runtime) },
    { method: "POST",   pattern: ["api", "agents", "build"],         handler: (q, r) => handleBuildAgent(q, r, runtime) },
    { method: "POST",   pattern: ["api", "agents", "import"],        handler: (q, r) => handleImportAgent(q, r, runtime) },
    { method: "GET",    pattern: ["api", "agents", ":id"],           handler: (q, r, p) => handleGetAgent(q, r, p, runtime) },
    { method: "DELETE", pattern: ["api", "agents", ":id"],           handler: (q, r, p) => handleDeleteAgent(q, r, p, runtime) },
    { method: "GET",    pattern: ["api", "agents", ":id", "runs"],   handler: (q, r, p) => handleAgentRuns(q, r, p, runtime) },
    { method: "GET",    pattern: ["api", "agents", ":id", "memory"], handler: (q, r, p) => handleGetAgentMemory(q, r, p, runtime) },
    { method: "DELETE", pattern: ["api", "agents", ":id", "memory"], handler: (q, r, p) => handleClearAgentMemory(q, r, p, runtime) },
    { method: "GET",    pattern: ["api", "runs"],                    handler: (q, r) => handleListRuns(q, r, runtime) },
    { method: "POST",   pattern: ["api", "runs"],                    handler: (q, r) => handleStartRun(q, r, runtime) },
    { method: "GET",    pattern: ["api", "runs", ":id"],             handler: (q, r, p) => handleGetRun(q, r, p, runtime) },
    { method: "GET",    pattern: ["api", "runs", ":id", "stream"],   handler: (q, r, p) => handleRunStream(q, r, p, runtime) },
    { method: "GET",    pattern: ["api", "runs", ":id", "events"],   handler: (q, r, p) => handleRunEvents(q, r, p, runtime) },
    { method: "GET",    pattern: ["api", "runs", ":id", "explain"],  handler: (q, r, p) => handleRunExplain(q, r, p, runtime) },
    { method: "GET",    pattern: ["api", "runs", ":id", "diagnose"], handler: (q, r, p) => handleRunDiagnose(q, r, p, runtime) },
    { method: "POST",   pattern: ["api", "runs", ":id", "retry"],    handler: (q, r, p) => handleRunRetry(q, r, p, runtime) },
    { method: "GET",    pattern: ["api", "agents", ":id", "explain-build"], handler: (q, r, p) => handleExplainBuild(q, r, p, runtime) },
    { method: "GET",    pattern: ["api", "capabilities"],                              handler: (q, r) => handleListCapabilities(q, r, runtime) },
    { method: "POST",   pattern: ["api", "capabilities"],                              handler: (q, r) => handleInstallCapability(q, r, runtime) },
    { method: "GET",    pattern: ["api", "capabilities", ":name", "source"],          handler: (q, r, p) => handleGetCapabilitySource(q, r, p, runtime) },
    { method: "PUT",    pattern: ["api", "capabilities", ":name"],                    handler: (q, r, p) => handleUpdateCapability(q, r, p, runtime) },
    { method: "PATCH",  pattern: ["api", "capabilities", ":name"],                    handler: (q, r, p) => handlePatchCapability(q, r, p, runtime) },
    { method: "POST",   pattern: ["api", "capabilities", ":name", "enable"],          handler: (q, r, p) => handleEnableCapability(q, r, p, runtime) },
    { method: "POST",   pattern: ["api", "capabilities", ":name", "disable"],         handler: (q, r, p) => handleDisableCapability(q, r, p, runtime) },
    { method: "DELETE", pattern: ["api", "capabilities", ":name"],                    handler: (q, r, p) => handleUninstallCapability(q, r, p, runtime) },
    { method: "GET",    pattern: ["api", "mcp"],                     handler: (q, r) => handleListMcp(q, r, runtime) },
    { method: "POST",   pattern: ["api", "mcp"],                     handler: (q, r) => handleConnectMcp(q, r, runtime) },
    { method: "DELETE", pattern: ["api", "mcp", ":name"],            handler: (q, r, p) => handleDisconnectMcp(q, r, p, runtime) },
    { method: "GET",    pattern: ["api", "approvals"],                            handler: (q, r) => handleListApprovals(q, r, runtime) },
    { method: "POST",   pattern: ["api", "approvals", ":id", "resolve"],         handler: (q, r, p) => handleResolveApproval(q, r, p, runtime) },
    { method: "GET",    pattern: ["api", "schedules"],               handler: (q, r) => handleListSchedules(q, r, runtime) },
    { method: "POST",   pattern: ["api", "schedules"],               handler: (q, r) => handleCreateSchedule(q, r, runtime) },
    { method: "GET",    pattern: ["api", "schedules", ":id"],        handler: (q, r, p) => handleGetSchedule(q, r, p, runtime) },
    { method: "PATCH",  pattern: ["api", "schedules", ":id"],        handler: (q, r, p) => handlePatchSchedule(q, r, p, runtime) },
    { method: "DELETE", pattern: ["api", "schedules", ":id"],        handler: (q, r, p) => handleDeleteSchedule(q, r, p, runtime) },
  ];

  const server = createServer(async (req, res) => {
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,PATCH,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      });
      res.end();
      return;
    }

    const url = new URL(req.url ?? "/", `http://localhost`);
    const path = url.pathname;
    const method = req.method ?? "GET";

    const match = matchRoute(routes, method, path);
    if (!match) {
      jsonError(res, 404, `No route for ${method} ${path}`);
      return;
    }

    try {
      await match.handler(req, res, match.params);
    } catch (err) {
      log.error({ err }, "unhandled route error");
      jsonError(res, 500, (err as Error).message ?? "internal error");
    }
  });

  return server;
}

// ── handlers ──────────────────────────────────────────────────────────────────

async function handleHealth(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  json(res, 200, { ok: true, ts: Date.now() });
}

async function handleListAgents(_req: IncomingMessage, res: ServerResponse, rt: KrelvanRuntime): Promise<void> {
  const agents = rt.agentRegistry.list();
  json(res, 200, { agents });
}

async function handleCreateAgent(req: IncomingMessage, res: ServerResponse, rt: KrelvanRuntime): Promise<void> {
  const raw = await readBody(req);
  let body: { intent?: string; apiKey?: string };
  try { body = JSON.parse(raw); } catch { jsonError(res, 400, "invalid JSON"); return; }
  if (!body.intent?.trim()) { jsonError(res, 400, "intent is required"); return; }

  const result = await rt.compiler.compile(
    body.intent.trim(),
    {
      kind: "owner",
      id: "owner-demo",
      allowedCapabilities: rt.agentRegistry.defaultAllowedCapabilities(),
      maxRunBudgetCents: 10_000,
    },
    rt.now(),
  );
  if (!result.ok) {
    json(res, 422, { error: "compile_failed", issues: result.issues });
    return;
  }

  const agent = rt.agentRegistry.save(result.signed);
  json(res, 201, { agent });
}

async function handleBuildAgent(req: IncomingMessage, res: ServerResponse, rt: KrelvanRuntime): Promise<void> {
  const raw = await readBody(req);
  let body: { intent?: string };
  try { body = JSON.parse(raw); } catch { jsonError(res, 400, "invalid JSON"); return; }
  if (!body.intent?.trim()) { jsonError(res, 400, "intent is required"); return; }

  const result = await rt.buildAgent(body.intent.trim());

  if (!result.ok) {
    json(res, 422, {
      error: "compile_failed",
      message: result.error,
      attempts: result.attempts,
      issues: result.issues,
    });
    return;
  }

  const { agent, attempts, warnings } = result;
  const manifest = agent.signed.manifest;
  json(res, 201, {
    agent,
    attempts,
    warnings,
    graph: {
      nodes: manifest.nodes.map(n => ({ id: n.id, role: n.role, capabilities: n.capabilities, autonomy: n.autonomy })),
      edges: manifest.edges ?? [],
      entry: manifest.entry,
    },
  });
}

async function handleImportAgent(req: IncomingMessage, res: ServerResponse, rt: KrelvanRuntime): Promise<void> {
  const raw = await readBody(req);
  let manifest: unknown;
  try { manifest = JSON.parse(raw); } catch { jsonError(res, 400, "invalid JSON"); return; }

  const result = rt.importManifest(manifest as Manifest);
  if (!result.ok) {
    json(res, 422, { error: "invalid_manifest", issues: result.issues });
    return;
  }
  json(res, 201, { agent: result.agent });
}

async function handleGetAgent(_req: IncomingMessage, res: ServerResponse, params: Record<string, string>, rt: KrelvanRuntime): Promise<void> {
  const agent = rt.agentRegistry.get(params["id"] ?? "");
  if (!agent) { jsonError(res, 404, "agent not found"); return; }
  json(res, 200, { agent });
}

async function handleDeleteAgent(_req: IncomingMessage, res: ServerResponse, params: Record<string, string>, rt: KrelvanRuntime): Promise<void> {
  const id = params["id"] ?? "";
  const agent = rt.agentRegistry.get(id);
  if (!agent) { jsonError(res, 404, "agent not found"); return; }
  const activeRun = rt.runRegistry.list().find(r => r.agentId === id && r.status === "running");
  if (activeRun) { jsonError(res, 409, "agent has an active run — wait for it to finish"); return; }
  rt.agentRegistry.delete(id);
  json(res, 200, { ok: true, id });
}

async function handleAgentRuns(_req: IncomingMessage, res: ServerResponse, params: Record<string, string>, rt: KrelvanRuntime): Promise<void> {
  const agentId = params["id"] ?? "";
  const agent = rt.agentRegistry.get(agentId);
  if (!agent) { jsonError(res, 404, "agent not found"); return; }
  const runs = rt.getAgentRuns(agentId);
  json(res, 200, { runs, agentId });
}

async function handleListRuns(_req: IncomingMessage, res: ServerResponse, rt: KrelvanRuntime): Promise<void> {
  const runs = rt.runRegistry.list();
  json(res, 200, { runs });
}

async function handleStartRun(req: IncomingMessage, res: ServerResponse, rt: KrelvanRuntime): Promise<void> {
  const raw = await readBody(req);
  let body: { agentId?: string; initialState?: Record<string, string | number | boolean | null> };
  try { body = JSON.parse(raw); } catch { jsonError(res, 400, "invalid JSON"); return; }
  if (!body.agentId) { jsonError(res, 400, "agentId is required"); return; }

  const agent = rt.agentRegistry.get(body.agentId);
  if (!agent) { jsonError(res, 404, "agent not found"); return; }

  const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const runRecord = rt.runRegistry.create({ agentId: body.agentId, runId, manifestName: agent.signed.manifest.name });

  // Run async — do NOT await; return the run record immediately so the UI can poll.
  void rt.executeRun(runRecord.runId, agent.signed.manifest, body.initialState ?? {}, body.agentId);

  json(res, 201, { run: runRecord });
}

async function handleGetRun(_req: IncomingMessage, res: ServerResponse, params: Record<string, string>, rt: KrelvanRuntime): Promise<void> {
  const record = rt.runRegistry.get(params["id"] ?? "");
  if (!record) { jsonError(res, 404, "run not found"); return; }

  const events = await rt.store.readRun("default", record.runId);
  const { project } = await import("../core/kernel/project.js");
  const p = project(events);

  const agent = rt.agentRegistry.get(record.agentId);
  const manifest = agent ? agent.signed.manifest : null;

  json(res, 200, {
    run: record,
    manifest,
    projection: {
      started: p.started,
      completed: p.completed,
      failed: p.failed,
      currentNode: p.currentNode,
      lastConcludedNode: p.lastConcludedNode,
      budget: p.budget,
      nodes: p.nodes,
      state: p.state,
    },
    eventCount: events.length,
  });
}

async function handleRunStream(req: IncomingMessage, res: ServerResponse, params: Record<string, string>, rt: KrelvanRuntime): Promise<void> {
  const record = rt.runRegistry.get(params["id"] ?? "");
  if (!record) { jsonError(res, 404, "run not found"); return; }

  const runId = record.runId;

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });

  const TERMINAL_STATUSES = new Set(["completed", "failed", "halted"]);

  let offset = 0;       // next ledger offset to emit
  let lastStatus = record.status;

  function sendEvent(data: unknown): void {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  }

  function sendNamedEvent(name: string, data: unknown): void {
    res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  function sendHeartbeat(): void {
    res.write(`: heartbeat\n\n`);
  }

  function close(): void {
    clearInterval(pollTimer);
    clearInterval(heartbeatTimer);
    res.end();
  }

  req.on("close", () => {
    clearInterval(pollTimer);
    clearInterval(heartbeatTimer);
  });

  const pollTimer = setInterval(async () => {
    // Stop if socket has gone away.
    if (res.socket?.destroyed) {
      clearInterval(pollTimer);
      clearInterval(heartbeatTimer);
      return;
    }

    let events: import("../core/ledger/event.js").LedgerEvent[];
    try {
      events = await rt.store.readRun("default", runId);
    } catch (err) {
      log.error({ err, runId }, "SSE poll: store.readRun failed");
      return;
    }

    // Emit any new events since last known offset.
    for (const e of events) {
      if (e.offset < offset) continue;
      const safe = {
        id: e.id,
        offset: e.offset,
        type: e.type,
        author: e.author,
        ts: e.ts,
        nodeId: e.scope.nodeId,
        payload: e.payload,
      };
      sendEvent(safe);
      offset = e.offset + 1;
    }

    // Check for run status change.
    const current = rt.runRegistry.get(runId);
    const currentStatus = current?.status ?? lastStatus;
    if (currentStatus !== lastStatus) {
      sendNamedEvent("status", { status: currentStatus, finishedAt: current?.finishedAt });
      lastStatus = currentStatus;
    }

    // Close when terminal.
    if (TERMINAL_STATUSES.has(lastStatus)) {
      sendNamedEvent("done", {});
      close();
    }
  }, 400);

  const heartbeatTimer = setInterval(() => {
    if (res.socket?.destroyed) return;
    sendHeartbeat();
  }, 15_000);
}

async function handleRunEvents(_req: IncomingMessage, res: ServerResponse, params: Record<string, string>, rt: KrelvanRuntime): Promise<void> {
  const record = rt.runRegistry.get(params["id"] ?? "");
  if (!record) { jsonError(res, 404, "run not found"); return; }

  const events = await rt.store.readRun("default", record.runId);
  // Strip sig (large) but keep all other fields for the UI
  const safe = events.map(e => ({
    id: e.id,
    offset: e.offset,
    type: e.type,
    author: e.author,
    ts: e.ts,
    nodeId: e.scope.nodeId,
    payload: e.payload,
  }));
  json(res, 200, { events: safe, runId: record.runId });
}

async function handleRunExplain(_req: IncomingMessage, res: ServerResponse, params: Record<string, string>, rt: KrelvanRuntime): Promise<void> {
  const record = rt.runRegistry.get(params["id"] ?? "");
  if (!record) { jsonError(res, 404, "run not found"); return; }

  if (!rt.hasLlm) { jsonError(res, 503, "no LLM provider configured — set KRELVAN_LLM_PROVIDER + KRELVAN_LLM_API_KEY (or KRELVAN_ANTHROPIC_KEY for Anthropic)"); return; }

  const events = await rt.store.readRun("default", record.runId);

  // Build a concise event summary for the prompt
  const eventLines = events.map(e => {
    const base = `[${e.offset}] ${e.type}`;
    const nodePrefix = e.scope.nodeId ? ` node=${e.scope.nodeId}` : "";
    const p = e.payload as Record<string, unknown>;
    let detail = "";
    switch (e.type) {
      case "RunStarted":        detail = ` manifest=${String(p["manifest"] ?? "")}`;  break;
      case "AdmissionDecision": detail = p["admitted"] ? ` admitted` : ` DENIED reason=${String(p["reason"] ?? "")}`; break;
      case "NodeEntered":       detail = ""; break;
      case "EffectRequested":   detail = ` cap=${String(p["capability"] ?? "")}`; break;
      case "EffectResult":      detail = ` cap=${String(p["capability"] ?? "")} ok=${String(p["ok"] ?? "")} output=${JSON.stringify(p["output"] ?? {}).slice(0, 120)}`; break;
      case "NodeConcluded":     detail = ""; break;
      case "RunCompleted":      detail = ` completed`; break;
      case "RunFailed":         detail = ` reason=${String(p["reason"] ?? "")}`; break;
      case "AwaitRequested":    detail = ` capability=${String((p["call"] as Record<string, unknown>)?.["capability"] ?? "")} correlationId=${String(p["correlationId"] ?? "")}`; break;
      case "AwaitResolved":     detail = ` decision=${String(p["decision"] ?? "")} correlationId=${String(p["correlationId"] ?? "")}`; break;
    }
    return `${base}${nodePrefix}${detail}`;
  });

  const runSummary = [
    `Run ID: ${record.runId}`,
    `Agent: ${record.manifestName}`,
    `Status: ${record.status}`,
    `Started: ${new Date(record.createdAt).toISOString()}`,
    record.finishedAt ? `Finished: ${new Date(record.finishedAt).toISOString()}` : null,
  ].filter(Boolean).join("\n");

  const prompt = [
    "You are explaining a Krelvan AI agent run to a non-technical user.",
    "Given the event log below, write a clear, friendly explanation:",
    "1. What the agent did overall (1–2 sentences).",
    "2. What each node did and what it produced (one bullet per node, in order).",
    "3. If the run failed: why it failed, which step caused it, and what might fix it.",
    "Be specific. Use the actual node names and capability names. Do not mention 'ledger' or 'events'.",
    "Do NOT mention cost, money, cents, dollars, budget, or spend — pricing is never shown to the user.",
    "",
    `=== Run summary ===`,
    runSummary,
    "",
    `=== Event log (${events.length} events) ===`,
    eventLines.join("\n"),
  ].join("\n");

  let explanation: string;
  try {
    const provider = process.env["KRELVAN_LLM_PROVIDER"] ?? "anthropic";
    const model = process.env["KRELVAN_LLM_MODEL"] ?? (provider === "ollama" ? "llama3.2" : provider === "openai" ? "gpt-4o-mini" : "claude-haiku-4-5-20251001");
    const client = getLLMClient();
    const response = await client.complete({
      system: "You are explaining a Krelvan AI agent run to a non-technical user. Be clear, specific, and friendly.",
      messages: [{ role: "user", content: prompt }],
      model,
      maxTokens: 1024,
      temperature: 0,
    });
    explanation = response.text;
    if (!explanation) { jsonError(res, 502, "LLM returned no content"); return; }
  } catch (err) {
    log.error({ err: (err as Error).message }, "explain LLM failed");
    jsonError(res, 502, `LLM error: ${(err as Error).message}`);
    return;
  }

  json(res, 200, { explanation, generatedAt: Date.now(), runId: record.runId });
}

/**
 * GET /api/runs/:id/diagnose — failure-reasoning.
 *
 * Reads the run's signed, tamper-evident ledger and reasons over it to produce a
 * STRUCTURED diagnosis: root-cause hypothesis, the exact failing step, contributing
 * factors, a concrete fix, and whether a retry is worthwhile. This is grounded
 * entirely in the recorded events — the agentic capability the ledger uniquely
 * enables (you can reason about *why* a run failed, from a trustworthy record).
 * Only meaningful for failed / halted runs.
 */
async function handleRunDiagnose(_req: IncomingMessage, res: ServerResponse, params: Record<string, string>, rt: KrelvanRuntime): Promise<void> {
  const record = rt.runRegistry.get(params["id"] ?? "");
  if (!record) { jsonError(res, 404, "run not found"); return; }
  if (record.status !== "failed" && record.status !== "halted") {
    jsonError(res, 409, "diagnosis is only available for failed or halted runs");
    return;
  }
  if (!rt.hasLlm) { jsonError(res, 503, "no LLM provider configured — set KRELVAN_LLM_PROVIDER + an API key"); return; }

  const events = await rt.store.readRun("default", record.runId);

  // Reconstruct the failure trace from the ledger: ordered events + the failing step.
  const trace = events.map(e => {
    const p = e.payload as Record<string, unknown>;
    const node = e.scope.nodeId ? ` node=${e.scope.nodeId}` : "";
    let d = "";
    switch (e.type) {
      case "RunStarted":        d = ` manifest=${String(p["manifest"] ?? "")}`; break;
      case "AdmissionDecision": d = p["admitted"] ? ` admitted` : ` DENIED reason="${String(p["reason"] ?? "")}"`; break;
      case "EffectRequested":   d = ` cap=${String(p["capability"] ?? "")}`; break;
      case "EffectResult":      d = ` cap=${String(p["capability"] ?? "")} ok=${String(p["ok"] ?? "")} output=${JSON.stringify(p["output"] ?? {}).slice(0, 160)}`; break;
      case "RunFailed":         d = ` reason="${String(p["reason"] ?? "")}"`; break;
      case "AwaitRequested":    d = ` awaiting=${String((p["call"] as Record<string, unknown>)?.["capability"] ?? "")}`; break;
    }
    return `[${e.offset}] ${e.type}${node}${d}`;
  }).join("\n");

  const failEvent = [...events].reverse().find(e => e.type === "RunFailed");
  const failReason = failEvent ? String((failEvent.payload as Record<string, unknown>)["reason"] ?? "") : record.reason ?? "unknown";

  const prompt = [
    `You are an SRE-grade failure analyst for a Krelvan AI agent run. Reason over the signed event log and diagnose WHY it failed.`,
    `Agent: ${record.manifestName}. Status: ${record.status}. Failure reason on record: "${failReason}".`,
    ``,
    `=== Signed event log (${events.length} events, in order) ===`,
    trace,
    ``,
    `Respond with ONLY a JSON object (no prose, no markdown) of this exact shape:`,
    `{"rootCause": string, "failingStep": string, "contributingFactors": string[], "fixStrategy": string, "retryWorthwhile": boolean, "retryNote": string}`,
    `- rootCause: the single most likely cause, specific, referencing the actual node/capability.`,
    `- failingStep: the node id (and capability) where it broke.`,
    `- contributingFactors: 1-3 secondary factors, or [] if none.`,
    `- fixStrategy: a concrete, actionable fix (what to change in the agent or its inputs).`,
    `- retryWorthwhile: true only if a retry with the fix would plausibly succeed.`,
    `- retryNote: one line on what to change before retrying.`,
    `Do NOT mention cost, money, or budget. Be specific and grounded in the events above.`,
  ].join("\n");

  try {
    const provider = process.env["KRELVAN_LLM_PROVIDER"] ?? "anthropic";
    const model = process.env["KRELVAN_LLM_MODEL"] ?? (provider === "ollama" ? "llama3.2" : provider === "openai" ? "gpt-4o-mini" : "claude-haiku-4-5-20251001");
    const client = getLLMClient();
    const response = await client.complete({
      system: "You are a precise failure analyst. You output only valid JSON. You reason strictly from the provided event log.",
      messages: [{ role: "user", content: prompt }],
      model, maxTokens: 900, temperature: 0,
    });
    let raw = (response.text ?? "").trim();
    // tolerate ```json fences the model may add
    const m = raw.match(/\{[\s\S]*\}/);
    if (m) raw = m[0];
    let diagnosis: Record<string, unknown>;
    try { diagnosis = JSON.parse(raw); }
    catch { jsonError(res, 502, "diagnosis model returned unparseable output"); return; }
    json(res, 200, { diagnosis, failReason, eventCount: events.length, generatedAt: Date.now(), runId: record.runId });
  } catch (err) {
    log.error({ err: (err as Error).message }, "diagnose LLM failed");
    jsonError(res, 502, `LLM error: ${(err as Error).message}`);
  }
}

/**
 * POST /api/runs/:id/retry — auto-retry-with-fix.
 *
 * The genuinely-agentic correction loop: take the failed run's original goal, fold in
 * the failure diagnosis's fix, rebuild a CORRECTED agent, and run it. Not a dumb retry
 * of the same broken graph — a new attempt informed by reasoning over what went wrong.
 * Body (optional): { fixStrategy?: string } — if omitted, the endpoint diagnoses first.
 */
async function handleRunRetry(req: IncomingMessage, res: ServerResponse, params: Record<string, string>, rt: KrelvanRuntime): Promise<void> {
  const record = rt.runRegistry.get(params["id"] ?? "");
  if (!record) { jsonError(res, 404, "run not found"); return; }
  if (record.status !== "failed" && record.status !== "halted") {
    jsonError(res, 409, "retry-with-fix is only available for failed or halted runs"); return;
  }
  if (!rt.hasLlm) { jsonError(res, 503, "no LLM provider configured"); return; }

  const agent = rt.agentRegistry.get(record.agentId);
  if (!agent) { jsonError(res, 404, "the agent for this run no longer exists"); return; }
  const originalIntent = agent.signed.manifest.intent;

  let body: { fixStrategy?: string } = {};
  try { const raw = await readBody(req); if (raw) body = JSON.parse(raw); } catch { /* optional body */ }

  // Get the fix: from the caller, or by diagnosing now.
  let fixStrategy = body.fixStrategy?.trim();
  let failReason = record.reason ?? "";
  if (!fixStrategy) {
    const events = await rt.store.readRun("default", record.runId);
    const failEvent = [...events].reverse().find(e => e.type === "RunFailed");
    failReason = failEvent ? String((failEvent.payload as Record<string, unknown>)["reason"] ?? "") : failReason;
    const trace = events.map(e => {
      const p = e.payload as Record<string, unknown>;
      const node = e.scope.nodeId ? ` node=${e.scope.nodeId}` : "";
      let d = "";
      if (e.type === "EffectResult") d = ` cap=${String(p["capability"] ?? "")} ok=${String(p["ok"] ?? "")} output=${JSON.stringify(p["output"] ?? {}).slice(0, 140)}`;
      else if (e.type === "RunFailed") d = ` reason="${String(p["reason"] ?? "")}"`;
      else if (e.type === "AdmissionDecision") d = p["admitted"] ? " admitted" : ` DENIED reason="${String(p["reason"] ?? "")}"`;
      return `[${e.offset}] ${e.type}${node}${d}`;
    }).join("\n");
    try {
      const provider = process.env["KRELVAN_LLM_PROVIDER"] ?? "anthropic";
      const model = process.env["KRELVAN_LLM_MODEL"] ?? (provider === "ollama" ? "llama3.2" : provider === "openai" ? "gpt-4o-mini" : "claude-haiku-4-5-20251001");
      const client = getLLMClient();
      const r = await client.complete({
        system: "You are a failure analyst. Output one concrete sentence describing the fix. No prose, no cost mentions.",
        messages: [{ role: "user", content: `Agent goal: "${originalIntent}". It failed: "${failReason}".\nSigned log:\n${trace}\n\nIn ONE sentence, the concrete fix to the agent's design so a rebuild would succeed:` }],
        model, maxTokens: 200, temperature: 0,
      });
      fixStrategy = (r.text ?? "").trim();
    } catch (err) { jsonError(res, 502, `diagnosis failed: ${(err as Error).message}`); return; }
  }
  if (!fixStrategy) { jsonError(res, 502, "could not determine a fix"); return; }

  // Rebuild a corrected agent with the fix folded into the goal, then run it.
  const revisedIntent = `${originalIntent}\n\nIMPORTANT — a previous attempt failed because: ${failReason}. Apply this fix when designing the agent: ${fixStrategy}`;
  const built = await rt.buildAgent(revisedIntent);
  if (!built.ok) { json(res, 422, { error: "rebuild_failed", message: built.error, fixStrategy }); return; }

  const newAgent = built.agent;
  const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const runRecord = rt.runRegistry.create({ agentId: newAgent.id, runId, manifestName: newAgent.signed.manifest.name });
  void rt.executeRun(runRecord.runId, newAgent.signed.manifest, {}, newAgent.id);

  json(res, 201, { run: runRecord, agent: newAgent, fixStrategy, basedOnRun: record.runId });
}

async function handleExplainBuild(_req: IncomingMessage, res: ServerResponse, params: Record<string, string>, rt: KrelvanRuntime): Promise<void> {
  const agent = rt.agentRegistry.get(params["id"] ?? "");
  if (!agent) { jsonError(res, 404, "agent not found"); return; }

  if (!rt.hasLlm) { jsonError(res, 503, "no LLM provider configured"); return; }

  const manifest = agent.signed.manifest;
  const nodeLines = manifest.nodes.map(n =>
    `  - ${n.id} (${n.role.slice(0, 80)}): ${n.capabilities.map(c => c.name).join(", ")}`
  ).join("\n");
  const edgeLines = (manifest.edges ?? []).map(e => `  - ${e.from} → ${e.to}`).join("\n");

  const prompt = [
    `You are the architect who just designed this agent. Explain your design decisions in 2–3 sentences, written in first person.`,
    `Focus on WHY — why this number of nodes, why these capabilities, why this routing. Be specific about the trade-offs.`,
    `Do not describe what the agent does (the user can see that). Explain why it is built THIS way and not another way.`,
    `Keep it under 60 words. No bullet points. Plain prose.`,
    ``,
    `Intent: ${agent.signed.provenance.intent}`,
    ``,
    `Nodes:`,
    nodeLines,
    ``,
    `Edges:`,
    edgeLines || "  (single node, no routing needed)",
    `Entry: ${manifest.entry}`,
  ].join("\n");

  let rationale: string;
  try {
    const provider = process.env["KRELVAN_LLM_PROVIDER"] ?? "anthropic";
    const model = process.env["KRELVAN_LLM_MODEL"] ?? (provider === "ollama" ? "llama3.2" : provider === "openai" ? "gpt-4o-mini" : "claude-haiku-4-5-20251001");
    const client = getLLMClient();
    const response = await client.complete({
      system: "You are a concise AI architect explaining your design decisions. Write in first person. Under 60 words.",
      messages: [{ role: "user", content: prompt }],
      model,
      maxTokens: 256,
      temperature: 0,
    });
    rationale = response.text?.trim() ?? "";
    if (!rationale) { jsonError(res, 502, "LLM returned no content"); return; }
  } catch (err) {
    log.error({ err: (err as Error).message }, "explain-build LLM failed");
    jsonError(res, 502, `LLM error: ${(err as Error).message}`);
    return;
  }

  json(res, 200, { rationale, agentId: agent.id, generatedAt: Date.now() });
}

async function handleListCapabilities(_req: IncomingMessage, res: ServerResponse, rt: KrelvanRuntime): Promise<void> {
  const caps = rt.capabilityRegistry.list();
  json(res, 200, { capabilities: caps });
}

/**
 * POST /api/capabilities
 * Supports two install modes:
 *   1. JSON body { yaml: string, name: string } → legacy in-memory YAML install
 *   2. multipart/form-data with file field + optional name/version fields → file-based plugin install
 */
async function handleInstallCapability(req: IncomingMessage, res: ServerResponse, rt: KrelvanRuntime): Promise<void> {
  const contentType = req.headers["content-type"] ?? "";

  if (contentType.startsWith("multipart/form-data")) {
    // ── Multipart: file upload (YAML or TypeScript plugin) ──────────────────
    const boundaryMatch = contentType.match(/boundary=([^\s;]+)/);
    if (!boundaryMatch) { jsonError(res, 400, "multipart boundary missing"); return; }
    const boundary = boundaryMatch[1]!;
    const bodyBuf = await readBodyBuffer(req);
    const { fields, file } = parseMultipart(bodyBuf, boundary);

    if (!file) { jsonError(res, 400, "multipart request must include a file part"); return; }
    const fileName = fields["name"]?.trim() || file.filename;
    const version  = fields["version"]?.trim() || "1.0.0";

    const result = await rt.installPluginFromBytes({ fileName, content: file.content, version });
    if (!result.ok) {
      const status = result.error === "ALREADY_INSTALLED" ? 409 : result.error === "FILE_NOT_FOUND" ? 404 : 422;
      json(res, status, { error: result.error, detail: result.detail });
      return;
    }
    const cap = rt.capabilityRegistry.list().find(c => c.name === result.record.name);
    json(res, 201, { capability: cap ?? result.record });
    return;
  }

  // ── JSON: legacy inline YAML install ──────────────────────────────────────
  const raw = await readBody(req);
  let body: { yaml?: string; name?: string };
  try { body = JSON.parse(raw); } catch { jsonError(res, 400, "invalid JSON"); return; }
  if (!body.yaml?.trim()) { jsonError(res, 400, "yaml is required"); return; }
  if (!body.name?.trim()) { jsonError(res, 400, "name is required"); return; }

  const result = rt.installYamlCapability(body.name.trim(), body.yaml.trim());
  if (!result.ok) { json(res, 422, { error: result.error }); return; }
  json(res, 201, { capability: result.capability });
}

/** GET /api/capabilities/:name/source — view a capability's source (YAML editable). */
async function handleGetCapabilitySource(_req: IncomingMessage, res: ServerResponse, params: Record<string, string>, rt: KrelvanRuntime): Promise<void> {
  const name = params["name"] ?? "";
  const result = rt.getCapabilitySource(name);
  if (!result.ok) { jsonError(res, 404, result.error); return; }
  json(res, 200, result);
}

/** PUT /api/capabilities/:name — edit a YAML capability's source online. Body: { yaml }. */
async function handleUpdateCapability(req: IncomingMessage, res: ServerResponse, params: Record<string, string>, rt: KrelvanRuntime): Promise<void> {
  const name = params["name"] ?? "";
  const raw = await readBody(req);
  let body: { yaml?: string };
  try { body = JSON.parse(raw); } catch { jsonError(res, 400, "invalid JSON"); return; }
  if (!body.yaml?.trim()) { jsonError(res, 400, "yaml is required"); return; }
  const result = rt.updateYamlCapability(name, body.yaml);
  if (!result.ok) { json(res, 422, { error: result.error }); return; }
  json(res, 200, { capability: result.capability });
}

async function handlePatchCapability(req: IncomingMessage, res: ServerResponse, params: Record<string, string>, rt: KrelvanRuntime): Promise<void> {
  const name = params["name"] ?? "";
  const raw = await readBody(req);
  let body: { enabled?: boolean; reason?: string };
  try { body = JSON.parse(raw); } catch { jsonError(res, 400, "invalid JSON"); return; }

  if (body.enabled === true) {
    const result = await rt.enablePlugin(name);
    if (!result.ok) {
      const status = result.error === "NOT_FOUND" ? 404 : result.error === "MISSING_SECRETS" ? 422 : 400;
      json(res, status, { error: result.error, detail: result.detail });
      return;
    }
    const cap = rt.capabilityRegistry.list().find(c => c.name === name);
    json(res, 200, { capability: cap });
  } else if (body.enabled === false) {
    const result = await rt.disablePlugin(name, body.reason);
    if (!result.ok) {
      const status = result.error === "NOT_FOUND" ? 404 : 400;
      json(res, status, { error: result.error, detail: result.detail });
      return;
    }
    const cap = rt.capabilityRegistry.list().find(c => c.name === name);
    json(res, 200, { capability: cap });
  } else {
    jsonError(res, 400, "body must include { enabled: boolean }");
  }
}

async function handleEnableCapability(_req: IncomingMessage, res: ServerResponse, params: Record<string, string>, rt: KrelvanRuntime): Promise<void> {
  const name = params["name"] ?? "";
  const result = await rt.enablePlugin(name);
  if (!result.ok) {
    const status = result.error === "NOT_FOUND" ? 404 : result.error === "MISSING_SECRETS" ? 422 : 400;
    json(res, status, { error: result.error, detail: result.detail });
    return;
  }
  const cap = rt.capabilityRegistry.list().find(c => c.name === name);
  json(res, 200, { capability: cap });
}

async function handleDisableCapability(req: IncomingMessage, res: ServerResponse, params: Record<string, string>, rt: KrelvanRuntime): Promise<void> {
  const name = params["name"] ?? "";
  let reason: string | undefined;
  try {
    const raw = await readBody(req);
    if (raw.trim()) {
      const body = JSON.parse(raw) as { reason?: string };
      reason = body.reason;
    }
  } catch { /* reason stays undefined */ }
  const result = await rt.disablePlugin(name, reason);
  if (!result.ok) {
    const status = result.error === "NOT_FOUND" ? 404 : 400;
    json(res, status, { error: result.error, detail: result.detail });
    return;
  }
  const cap = rt.capabilityRegistry.list().find(c => c.name === name);
  json(res, 200, { capability: cap });
}

async function handleUninstallCapability(_req: IncomingMessage, res: ServerResponse, params: Record<string, string>, rt: KrelvanRuntime): Promise<void> {
  const name = params["name"] ?? "";
  // Try the full lifecycle uninstall first (for file-based plugins).
  const lifecycleResult = await rt.uninstallPlugin(name);
  if (lifecycleResult.ok) { json(res, 200, { ok: true }); return; }
  // If plugin wasn't in the lifecycle registry (e.g. legacy in-memory YAML), fall back.
  if (lifecycleResult.error === "NOT_FOUND") {
    const legacyResult = rt.capabilityRegistry.uninstall(name);
    if (!legacyResult.ok) { json(res, 404, { error: legacyResult.error }); return; }
    json(res, 200, { ok: true });
    return;
  }
  json(res, 422, { error: lifecycleResult.error, detail: lifecycleResult.detail });
}

async function handleListMcp(_req: IncomingMessage, res: ServerResponse, rt: KrelvanRuntime): Promise<void> {
  const servers = rt.mcpRegistry.listServers();
  json(res, 200, { servers });
}

async function handleConnectMcp(req: IncomingMessage, res: ServerResponse, rt: KrelvanRuntime): Promise<void> {
  const raw = await readBody(req);
  let body: unknown;
  try { body = JSON.parse(raw); } catch { jsonError(res, 400, "invalid JSON"); return; }

  const config = body as import("../core/mcp/mcp-client.js").McpServerConfig;
  if (!config.name?.trim()) { jsonError(res, 400, "name is required"); return; }
  if (!config.command && !config.url) { jsonError(res, 400, "either command or url is required"); return; }

  const result = await rt.connectMcp(config);
  if (!result.ok) { json(res, 422, { error: result.error }); return; }
  json(res, 201, { ok: true, tools: result.tools });
}

async function handleDisconnectMcp(_req: IncomingMessage, res: ServerResponse, params: Record<string, string>, rt: KrelvanRuntime): Promise<void> {
  await rt.disconnectMcp(params["name"] ?? "");
  json(res, 200, { ok: true });
}

// ── HITL approval handlers ────────────────────────────────────────────────────

async function handleListApprovals(_req: IncomingMessage, res: ServerResponse, rt: KrelvanRuntime): Promise<void> {
  const approvals = await rt.listPendingApprovals();
  json(res, 200, { approvals });
}

async function handleResolveApproval(req: IncomingMessage, res: ServerResponse, params: Record<string, string>, rt: KrelvanRuntime): Promise<void> {
  const correlationId = params["id"] ?? "";
  const raw = await readBody(req);
  let body: { decision?: string; runId?: string };
  try { body = JSON.parse(raw); } catch { jsonError(res, 400, "invalid JSON"); return; }

  if (!body.runId) { jsonError(res, 400, "runId is required"); return; }
  if (body.decision !== "approve" && body.decision !== "deny") {
    jsonError(res, 400, "decision must be 'approve' or 'deny'"); return;
  }

  const result = await rt.resolveApproval(body.runId, correlationId, body.decision);
  if (!result.ok) { json(res, 422, { error: result.error }); return; }
  json(res, 200, { ok: true, correlationId, decision: body.decision });
}

// ── Agent memory handlers ─────────────────────────────────────────────────────

async function handleGetAgentMemory(_req: IncomingMessage, res: ServerResponse, params: Record<string, string>, rt: KrelvanRuntime): Promise<void> {
  const agentId = params["id"] ?? "";
  if (!rt.agentRegistry.get(agentId)) { jsonError(res, 404, "agent not found"); return; }
  const memory = rt.getAgentMemory(agentId);
  json(res, 200, memory);
}

async function handleClearAgentMemory(_req: IncomingMessage, res: ServerResponse, params: Record<string, string>, rt: KrelvanRuntime): Promise<void> {
  const agentId = params["id"] ?? "";
  if (!rt.agentRegistry.get(agentId)) { jsonError(res, 404, "agent not found"); return; }

  // Block clear if agent is currently running
  const runningRun = rt.runRegistry.list().find(r => r.agentId === agentId && r.status === "running");
  if (runningRun) { jsonError(res, 409, "cannot clear memory while agent is running"); return; }

  const result = await rt.clearAgentMemory(agentId);
  json(res, 200, result);
}

// ── Schedule handlers ─────────────────────────────────────────────────────────

async function handleListSchedules(_req: IncomingMessage, res: ServerResponse, rt: KrelvanRuntime): Promise<void> {
  const schedules = rt.scheduleRegistry.list().map(s => ({
    ...s,
    armed: rt.scheduler.isArmed(s.id),
  }));
  json(res, 200, { schedules });
}

async function handleCreateSchedule(req: IncomingMessage, res: ServerResponse, rt: KrelvanRuntime): Promise<void> {
  const raw = await readBody(req);
  let body: { agentId?: string; kind?: string; spec?: string; label?: string };
  try { body = JSON.parse(raw); } catch { jsonError(res, 400, "invalid JSON"); return; }

  if (!body.agentId?.trim()) { jsonError(res, 400, "agentId is required"); return; }
  if (!body.kind || (body.kind !== "cron" && body.kind !== "interval")) {
    jsonError(res, 400, "kind must be 'cron' or 'interval'");
    return;
  }
  if (!body.spec?.trim()) { jsonError(res, 400, "spec is required"); return; }

  const result = rt.createSchedule({
    agentId: body.agentId.trim(),
    kind: body.kind,
    spec: body.spec.trim(),
    label: body.label,
  });

  if (!result.ok) { json(res, 422, { error: result.error }); return; }
  json(res, 201, { schedule: { ...result.schedule, armed: rt.scheduler.isArmed(result.schedule.id) } });
}

async function handleGetSchedule(_req: IncomingMessage, res: ServerResponse, params: Record<string, string>, rt: KrelvanRuntime): Promise<void> {
  const schedule = rt.scheduleRegistry.get(params["id"] ?? "");
  if (!schedule) { jsonError(res, 404, "schedule not found"); return; }
  json(res, 200, { schedule: { ...schedule, armed: rt.scheduler.isArmed(schedule.id) } });
}

async function handlePatchSchedule(req: IncomingMessage, res: ServerResponse, params: Record<string, string>, rt: KrelvanRuntime): Promise<void> {
  const id = params["id"] ?? "";
  const raw = await readBody(req);
  let body: { enabled?: boolean };
  try { body = JSON.parse(raw); } catch { jsonError(res, 400, "invalid JSON"); return; }

  const schedule = rt.scheduleRegistry.get(id);
  if (!schedule) { jsonError(res, 404, "schedule not found"); return; }

  if (body.enabled === true) {
    rt.scheduler.enable(id);
  } else if (body.enabled === false) {
    rt.scheduler.disable(id);
  }

  const updated = rt.scheduleRegistry.get(id);
  json(res, 200, { schedule: { ...updated, armed: rt.scheduler.isArmed(id) } });
}

async function handleDeleteSchedule(_req: IncomingMessage, res: ServerResponse, params: Record<string, string>, rt: KrelvanRuntime): Promise<void> {
  const id = params["id"] ?? "";
  if (!rt.scheduleRegistry.get(id)) { jsonError(res, 404, "schedule not found"); return; }
  rt.scheduler.disarm(id);
  rt.scheduleRegistry.delete(id);
  json(res, 200, { ok: true });
}
