/**
 * Typed API client — talks to the Krelvan API server.
 * All data the UI shows comes from here; nothing is hardcoded.
 */

export const API_BASE = process.env["NEXT_PUBLIC_API_URL"] ?? "http://localhost:3201";

export interface ManifestNode {
  id: string;
  role: string;
  autonomy: string;
  capabilities: { name: string; sideEffect: string; budgetCents: number }[];
}

export type ManifestExpr =
  | { op: "const"; value: string | number | boolean | null }
  | { op: "var"; key: string }
  | { op: "eq" | "ne" | "lt" | "lte" | "gt" | "gte"; left: ManifestExpr; right: ManifestExpr }
  | { op: "and" | "or"; clauses: ManifestExpr[] }
  | { op: "not"; clause: ManifestExpr };

export interface ManifestEdge {
  from: string;
  to: string;
  when?: ManifestExpr;
}

export interface AgentRecord {
  id: string;
  signed: {
    manifest: {
      name: string;
      intent: string;
      runBudgetCents: number;
      entry: string;
      nodes: ManifestNode[];
      edges: ManifestEdge[];
    };
    provenance: { intent: string; compiledAt: number };
  };
  createdAt: number;
  lastRunId?: string;
}

export interface BuildResult {
  agent: AgentRecord;
  attempts: number;
  warnings: string[];
  graph: {
    nodes: ManifestNode[];
    edges: ManifestEdge[];
    entry: string;
  };
}

export interface RunRecord {
  runId: string;
  agentId: string;
  manifestName: string;
  status: "pending" | "running" | "completed" | "failed" | "halted";
  createdAt: number;
  finishedAt?: number;
  spentCents?: number;
  reason?: string;
}

export interface CapabilityRecord {
  name: string;
  /** "builtin" = hardcoded in runtime; "yaml" / "typescript" = user-installed plugin */
  kind: "builtin" | "yaml" | "typescript";
  description?: string;
  sideEffect: string;
  estimateCents: number;
  installedAt: number;
  /** Only present for user-installed plugins */
  status?: "installed" | "enabled" | "disabled";
  version?: string;
  sourceHash?: string;
  secretRefs?: string[];
}

export interface LedgerEvent {
  id: string;
  offset: number;
  type: string;
  author: string;
  ts: number;
  nodeId?: string;
  payload: Record<string, unknown>;
}

export interface RunManifest {
  name: string;
  intent: string;
  runBudgetCents: number;
  entry: string;
  nodes: ManifestNode[];
  edges: ManifestEdge[];
  version?: number;
  maxNodeVisits?: number;
}

export interface RunDetail {
  run: RunRecord;
  manifest: RunManifest | null;
  projection: {
    started: boolean;
    completed: boolean;
    failed: boolean;
    currentNode: string | null;
    lastConcludedNode: string | null;
    budget: {
      runSpentCents: number;
      runReservedCents: number;
      perCapSpentCents: Record<string, number>;
    };
    nodes: Record<string, { entered: boolean; concluded: boolean; visits: number }>;
    state: Record<string, unknown>;
  };
  eventCount: number;
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText })) as { error?: string };
    throw new Error(err.error ?? `API error ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export async function listAgents(): Promise<AgentRecord[]> {
  const data = await apiFetch<{ agents: AgentRecord[] }>("/api/agents");
  return data.agents;
}

export async function getAgent(id: string): Promise<AgentRecord> {
  const data = await apiFetch<{ agent: AgentRecord }>(`/api/agents/${encodeURIComponent(id)}`);
  return data.agent;
}

export async function getAgentRuns(agentId: string): Promise<RunRecord[]> {
  const data = await apiFetch<{ runs: RunRecord[] }>(`/api/agents/${encodeURIComponent(agentId)}/runs`);
  return data.runs;
}

export async function createAgent(intent: string): Promise<AgentRecord> {
  const data = await apiFetch<{ agent: AgentRecord }>("/api/agents", {
    method: "POST",
    body: JSON.stringify({ intent }),
  });
  return data.agent;
}

export async function buildAgent(intent: string): Promise<BuildResult> {
  return apiFetch<BuildResult>("/api/agents/build", {
    method: "POST",
    body: JSON.stringify({ intent }),
  });
}

export async function deleteAgent(id: string): Promise<void> {
  await apiFetch(`/api/agents/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export async function explainBuild(agentId: string): Promise<{ rationale: string; generatedAt: number; agentId: string }> {
  return apiFetch(`/api/agents/${encodeURIComponent(agentId)}/explain-build`);
}

export async function listRuns(): Promise<RunRecord[]> {
  const data = await apiFetch<{ runs: RunRecord[] }>("/api/runs");
  return data.runs;
}

export async function startRun(agentId: string): Promise<RunRecord> {
  const data = await apiFetch<{ run: RunRecord }>("/api/runs", {
    method: "POST",
    body: JSON.stringify({ agentId }),
  });
  return data.run;
}

export async function getRun(runId: string): Promise<RunDetail> {
  return apiFetch<RunDetail>(`/api/runs/${runId}`);
}

export async function getRunEvents(runId: string): Promise<LedgerEvent[]> {
  const data = await apiFetch<{ events: LedgerEvent[] }>(`/api/runs/${runId}/events`);
  return data.events;
}

export interface RunExplanation {
  explanation: string;
  generatedAt: number;
  runId: string;
}

export async function explainRun(runId: string): Promise<RunExplanation> {
  return apiFetch<RunExplanation>(`/api/runs/${encodeURIComponent(runId)}/explain`);
}

export interface RunDiagnosis {
  diagnosis: {
    rootCause: string;
    failingStep: string;
    contributingFactors: string[];
    fixStrategy: string;
    retryWorthwhile: boolean;
    retryNote: string;
  };
  failReason: string;
  eventCount: number;
  generatedAt: number;
  runId: string;
}

/** Failure-reasoning: structured diagnosis of a failed/halted run, grounded in the ledger. */
export async function diagnoseRun(runId: string): Promise<RunDiagnosis> {
  return apiFetch<RunDiagnosis>(`/api/runs/${encodeURIComponent(runId)}/diagnose`);
}

export interface RetryResult { run: RunRecord; agent: AgentRecord; fixStrategy: string; basedOnRun: string; }
/** Auto-retry-with-fix: rebuild a corrected agent from the diagnosis and run it. */
export async function retryRunWithFix(runId: string, fixStrategy?: string): Promise<RetryResult> {
  return apiFetch<RetryResult>(`/api/runs/${encodeURIComponent(runId)}/retry`, {
    method: "POST",
    body: JSON.stringify(fixStrategy ? { fixStrategy } : {}),
  });
}

export async function listCapabilities(): Promise<CapabilityRecord[]> {
  const data = await apiFetch<{ capabilities: CapabilityRecord[] }>("/api/capabilities");
  return data.capabilities;
}

export async function installCapability(name: string, yaml: string): Promise<CapabilityRecord> {
  const data = await apiFetch<{ capability: CapabilityRecord }>("/api/capabilities", {
    method: "POST",
    body: JSON.stringify({ name, yaml }),
  });
  return data.capability;
}

export async function installCapabilityFile(file: File, version?: string): Promise<CapabilityRecord> {
  const form = new FormData();
  form.append("file", file, file.name);
  if (version) form.append("version", version);
  const res = await fetch(`${API_BASE}/api/capabilities`, { method: "POST", body: form });
  const data = await res.json() as { capability?: CapabilityRecord; error?: string; detail?: string };
  if (!res.ok) throw new Error(data.detail ?? data.error ?? `HTTP ${res.status}`);
  return data.capability!;
}

export async function enableCapability(name: string): Promise<CapabilityRecord> {
  const data = await apiFetch<{ capability: CapabilityRecord }>(
    `/api/capabilities/${encodeURIComponent(name)}/enable`,
    { method: "POST" },
  );
  return data.capability;
}

export async function disableCapability(name: string, reason?: string): Promise<CapabilityRecord> {
  const data = await apiFetch<{ capability: CapabilityRecord }>(
    `/api/capabilities/${encodeURIComponent(name)}/disable`,
    { method: "POST", body: reason ? JSON.stringify({ reason }) : "{}" },
  );
  return data.capability;
}

export async function uninstallCapability(name: string): Promise<void> {
  await apiFetch(`/api/capabilities/${encodeURIComponent(name)}`, { method: "DELETE" });
}

export interface CapabilitySource { kind: string; editable: boolean; content: string; }
export async function getCapabilitySource(name: string): Promise<CapabilitySource> {
  return apiFetch<CapabilitySource>(`/api/capabilities/${encodeURIComponent(name)}/source`);
}
export async function updateCapabilityYaml(name: string, yaml: string): Promise<CapabilityRecord> {
  const data = await apiFetch<{ capability: CapabilityRecord }>(`/api/capabilities/${encodeURIComponent(name)}`, {
    method: "PUT",
    body: JSON.stringify({ yaml }),
  });
  return data.capability;
}

export interface McpServerRecord {
  name: string;
  connected: boolean;
  tools: string[];
}

export interface McpServerConfig {
  name: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  defaultSideEffect?: string;
  estimateCents?: number;
}

export async function listMcpServers(): Promise<McpServerRecord[]> {
  const data = await apiFetch<{ servers: McpServerRecord[] }>("/api/mcp");
  return data.servers;
}

export async function connectMcpServer(config: McpServerConfig): Promise<{ tools: string[] }> {
  const data = await apiFetch<{ ok: true; tools: string[] }>("/api/mcp", {
    method: "POST",
    body: JSON.stringify(config),
  });
  return { tools: data.tools };
}

export async function disconnectMcpServer(name: string): Promise<void> {
  await apiFetch(`/api/mcp/${encodeURIComponent(name)}`, { method: "DELETE" });
}

// ── Schedules ─────────────────────────────────────────────────────────────────

export interface ScheduleRecord {
  id: string;
  agentId: string;
  agentName: string;
  kind: "cron" | "interval";
  spec: string;
  label: string;
  enabled: boolean;
  createdAt: number;
  lastRunAt?: number;
  lastRunId?: string;
  nextRunAt?: number;
  armed: boolean;
}

// ── HITL Approvals ────────────────────────────────────────────────────────────

export interface PendingApproval {
  correlationId: string;
  runId: string;
  agentId: string;
  agentName: string;
  nodeId: string;
  capability: string;
  requestedAt: number;
}

export async function listApprovals(): Promise<PendingApproval[]> {
  const data = await apiFetch<{ approvals: PendingApproval[] }>("/api/approvals");
  return data.approvals;
}

export async function resolveApproval(
  correlationId: string,
  runId: string,
  decision: "approve" | "deny",
): Promise<void> {
  await apiFetch(`/api/approvals/${encodeURIComponent(correlationId)}/resolve`, {
    method: "POST",
    body: JSON.stringify({ runId, decision }),
  });
}

export async function listSchedules(): Promise<ScheduleRecord[]> {
  const data = await apiFetch<{ schedules: ScheduleRecord[] }>("/api/schedules");
  return data.schedules;
}

export async function createSchedule(opts: {
  agentId: string;
  kind: "cron" | "interval";
  spec: string;
  label?: string;
}): Promise<ScheduleRecord> {
  const data = await apiFetch<{ schedule: ScheduleRecord }>("/api/schedules", {
    method: "POST",
    body: JSON.stringify(opts),
  });
  return data.schedule;
}

export async function toggleSchedule(id: string, enabled: boolean): Promise<ScheduleRecord> {
  const data = await apiFetch<{ schedule: ScheduleRecord }>(`/api/schedules/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ enabled }),
  });
  return data.schedule;
}

export async function deleteSchedule(id: string): Promise<void> {
  await apiFetch(`/api/schedules/${id}`, { method: "DELETE" });
}

// ── Secrets (customer-managed) ──────────────────────────────────────────────────

export interface SecretMeta {
  name: string;
  preview: string;   // masked — never the full value
  updatedAt: number;
}

export interface RequiredSecret {
  name: string;
  capability: string;
  set: boolean;
}

export async function listSecrets(): Promise<{ secrets: SecretMeta[]; required: RequiredSecret[] }> {
  return apiFetch<{ secrets: SecretMeta[]; required: RequiredSecret[] }>("/api/secrets");
}

export async function setSecret(name: string, value: string): Promise<SecretMeta> {
  const r = await apiFetch<{ ok: boolean; secret: SecretMeta }>(`/api/secrets/${encodeURIComponent(name)}`, {
    method: "PUT",
    body: JSON.stringify({ value }),
  });
  return r.secret;
}

export async function deleteSecret(name: string): Promise<void> {
  await apiFetch(`/api/secrets/${encodeURIComponent(name)}`, { method: "DELETE" });
}

// ── Agent Memory ──────────────────────────────────────────────────────────────

export type Provenance = "owner" | "tool-observed" | "channel" | "agent" | "memory";

export interface SemanticFact {
  key: string;
  value: string | number | boolean;
  derivedFrom: string[];
  provenance: Provenance;
  distilledBy: string;
  version: number;
  ts: number;
}

export interface Episode {
  runId: string;
  summary: string;
  provenance: Provenance;
  ts: number;
}

export interface Soul {
  name: string;
  values: string[];
  standingInstructions: string[];
  version: number;
}

export interface AgentMemory {
  agentId: string;
  semantic: SemanticFact[];
  episodic: Episode[];
  soul: Soul | null;
  counts: { semantic: number; episodic: number };
}

export async function getAgentMemory(agentId: string): Promise<AgentMemory> {
  return apiFetch<AgentMemory>(`/api/agents/${encodeURIComponent(agentId)}/memory`);
}

export async function clearAgentMemory(agentId: string): Promise<{ ok: boolean; clearedAt: number; semanticCount: number; episodicCount: number }> {
  return apiFetch(`/api/agents/${encodeURIComponent(agentId)}/memory`, { method: "DELETE" });
}

export function timeAgo(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}
