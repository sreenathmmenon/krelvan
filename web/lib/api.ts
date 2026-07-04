/**
 * Typed API client — talks to the Krelvan API server.
 * All data the UI shows comes from here; nothing is hardcoded.
 */

// Same-origin proxy path (default). The browser calls /proxy/api/... on the web
// origin; the Next server-side proxy (app/proxy/[...path]) forwards to the real API
// and injects the bearer token, so the token never reaches the browser and there is
// no cross-origin/CORS surface. Override with NEXT_PUBLIC_API_URL only for direct
// (token-in-browser) setups.
export const API_BASE = process.env["NEXT_PUBLIC_API_URL"] ?? "/proxy";

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
  signed?: boolean;
  sig?: { keyId: string; epoch: number; fingerprint: string } | null;
}

export type RunVerification =
  | { ok: true; runEvents: number; signedEvents: number; ledgerEvents: number; algorithm: string; nonRepudiable?: boolean }
  | { ok: false; error: string; detail: string };

/** Re-verify the run's signed ledger chain (the "prove what happened" action). */
export async function verifyRun(runId: string): Promise<RunVerification> {
  return apiFetch<RunVerification>(`/api/runs/${runId}/verify`);
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
  const headers: Record<string, string> = { "Content-Type": "application/json", ...(init?.headers as Record<string, string> | undefined) };
  // Attach the CSRF token (issued at login, kept in sessionStorage) on state-changing calls.
  const method = (init?.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD" && typeof window !== "undefined") {
    const csrf = sessionStorage.getItem("krelvan_csrf");
    if (csrf) headers["X-CSRF-Token"] = csrf;
  }
  const res = await fetch(`${API_BASE}${path}`, { ...init, headers });
  // A 401 inside the authenticated app means the session expired → bounce to login. But the
  // PUBLIC pages (marketing homepage, login, setup) intentionally make API calls that may 401
  // for a logged-out visitor and degrade gracefully — never redirect THOSE to login, or a
  // visitor can never see the homepage.
  if (res.status === 401 && typeof window !== "undefined") {
    const p = window.location.pathname;
    // Keep this in sync with middleware PUBLIC_PATHS. /faq is a public marketing page — a
    // logged-out visitor's FAQ API calls may 401 and must degrade gracefully, NOT bounce the
    // whole window to /login (that made clicking "FAQ" from the nav a dead-end sign-in wall).
    const isPublic = p === "/" || p === "/faq" || p.startsWith("/login") || p.startsWith("/setup");
    if (!isPublic) window.location.href = "/login";
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText })) as { error?: string };
    throw new Error(err.error ?? `API error ${res.status}`);
  }
  return res.json() as Promise<T>;
}

/** Log out: clears the session cookie (server-side) + local CSRF, then redirect to login. */
export async function logout(): Promise<void> {
  try { await fetch(`${API_BASE}/api/auth/logout`, { method: "POST" }); } catch { /* ignore */ }
  if (typeof window !== "undefined") { sessionStorage.removeItem("krelvan_csrf"); window.location.href = "/login"; }
}

// ── In-memory list cache (stale-while-revalidate) ───────────────────────────────
// Holds the last successful result for GET-list endpoints so a page can render its
// previous data INSTANTLY on revisit (no spinner flash) while it refreshes in the
// background. Lives only for the browser session; cleared implicitly on reload.
const listCache = new Map<string, unknown>();

/** Synchronously read the last cached value for a key (undefined if never fetched). */
export function getCached<T>(key: string): T | undefined {
  return listCache.get(key) as T | undefined;
}

export async function listAgents(): Promise<AgentRecord[]> {
  const data = await apiFetch<{ agents: AgentRecord[] }>("/api/agents");
  listCache.set("agents", data.agents);
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

export interface ModelStatus { hasLlm: boolean; provider: string; model?: string | null; source?: "in-app" | "env" }
/** Readiness: is a model wired up? Drives the build gate + the "Model connected" pill. */
export async function getStatus(): Promise<ModelStatus> {
  return apiFetch<ModelStatus>("/api/status");
}

/** Current model configuration (provider, model, whether a key is wired, source). */
export async function getModel(): Promise<ModelStatus> {
  return apiFetch<ModelStatus>("/api/model");
}

export interface ModelConfigInput { provider?: string; apiKey?: string; model?: string; baseUrl?: string }
/** Configure the LLM provider from the UI. Persists encrypted on this instance; effective on the next build. */
export async function setModel(cfg: ModelConfigInput): Promise<ModelStatus> {
  return apiFetch<ModelStatus>("/api/model", { method: "POST", body: JSON.stringify(cfg) });
}

export async function deleteAgent(id: string): Promise<void> {
  await apiFetch(`/api/agents/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export async function explainBuild(agentId: string): Promise<{ rationale: string; generatedAt: number; agentId: string }> {
  return apiFetch(`/api/agents/${encodeURIComponent(agentId)}/explain-build`);
}

export async function listRuns(): Promise<RunRecord[]> {
  const data = await apiFetch<{ runs: RunRecord[] }>("/api/runs");
  listCache.set("runs", data.runs);
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

/**
 * Background one-line summaries for run lists. Each summary is an LLM call (`explainRun`), so
 * firing one per run on load can flood a single-process API. This bounds it: only the most
 * recent `max` runs are summarised, at most `concurrency` at a time. `onSummary` is called as
 * each resolves; failures are silent (a missing summary is fine). Returns a cancel function.
 */
export function autoSummarizeRuns(
  runIds: string[],
  onSummary: (runId: string, summary: string | null) => void,
  opts: { max?: number; concurrency?: number } = {},
): () => void {
  const max = opts.max ?? 6;
  const concurrency = opts.concurrency ?? 2;
  const queue = runIds.slice(0, max);
  let cancelled = false;
  let active = 0;
  let i = 0;
  function pump() {
    while (!cancelled && active < concurrency && i < queue.length) {
      const runId = queue[i++]!;
      active++;
      onSummary(runId, null); // mark loading
      explainRun(runId)
        .then(res => {
          if (cancelled) return;
          const firstLine = res.explanation.split("\n").map(l => l.trim()).filter(Boolean).slice(0, 2).join(" ").slice(0, 220);
          onSummary(runId, firstLine);
        })
        .catch(() => { if (!cancelled) onSummary(runId, ""); }) // "" = tried, no summary
        .finally(() => { active--; if (!cancelled) pump(); });
    }
  }
  pump();
  return () => { cancelled = true; };
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
  listCache.set("capabilities", data.capabilities);
  return data.capabilities;
}

export async function installCapability(name: string, yaml: string): Promise<CapabilityRecord> {
  const data = await apiFetch<{ capability: CapabilityRecord }>("/api/capabilities", {
    method: "POST",
    body: JSON.stringify({ name, yaml }),
  });
  return data.capability;
}

export async function installCapabilityFile(
  file: File,
  version?: string,
  egressHosts?: readonly string[],
): Promise<CapabilityRecord> {
  const form = new FormData();
  form.append("file", file, file.name);
  if (version) form.append("version", version);
  // Sandboxed TS plugins reach the network only through hosts declared here (deny-by-default).
  if (egressHosts && egressHosts.length > 0) form.append("egressHosts", JSON.stringify(egressHosts));
  const res = await fetch(`${API_BASE}/api/capabilities`, { method: "POST", body: form });
  const data = await res.json() as { capability?: CapabilityRecord; error?: string; detail?: string };
  if (!res.ok) throw new Error(data.detail ?? data.error ?? `HTTP ${res.status}`);
  return data.capability!;
}

export interface TemplateInstallResult {
  agent: AgentRecord;
  installedCapabilities: string[];
  missingSecrets: string[];
}

/**
 * Install a whole agent template: the signed manifest + the YAML capabilities it needs,
 * in one call. Returns the created agent and which secrets still need setting.
 */
export async function installTemplate(payload: {
  manifest: unknown;
  capabilities?: { name: string; yaml: string }[];
  secretRefs?: string[];
}): Promise<TemplateInstallResult> {
  return apiFetch<TemplateInstallResult>("/api/templates/install", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

/**
 * The "make it mine" clone flow: bake the builder's settings (declared by the template's
 * customize block — rename / knowledge base / tone / autonomy toggles) into a fresh
 * manifest and install it as the builder's own named agent. Undeclared settings are
 * rejected by the server (deny-by-default).
 */
export async function customizeTemplate(payload: {
  manifest: unknown;
  settings: Record<string, string | number | boolean>;
  capabilities?: { name: string; yaml: string }[];
  secretRefs?: string[];
}): Promise<TemplateInstallResult> {
  return apiFetch<TemplateInstallResult>("/api/templates/customize", {
    method: "POST",
    body: JSON.stringify(payload),
  });
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
  tools?: string[];
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
  /** Human description of what this node does (from the manifest node role). */
  nodeRole?: string;
  /** The actual proposed action — what the agent wants to do, so you approve WHAT not just "send". */
  preview?: { label: string; value: string }[];
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
  listCache.set("schedules", data.schedules);
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

// ── Webhook triggers (inbound — fire an agent from an external system) ────────────

export interface TriggerStatus {
  enabled: boolean;
  url: string;
}

/** Is a webhook trigger enabled for this agent, and at what URL. */
export async function getTrigger(agentId: string): Promise<TriggerStatus> {
  return apiFetch<TriggerStatus>(`/api/agents/${encodeURIComponent(agentId)}/trigger`);
}

/** Mint (or rotate) the trigger token. The plaintext token is returned ONCE. */
export async function mintTrigger(agentId: string): Promise<{ token: string; url: string }> {
  return apiFetch<{ token: string; url: string }>(`/api/agents/${encodeURIComponent(agentId)}/trigger`, { method: "POST" });
}

/** Disable the webhook (revoke the token). */
export async function revokeTrigger(agentId: string): Promise<void> {
  await apiFetch(`/api/agents/${encodeURIComponent(agentId)}/trigger`, { method: "DELETE" });
}

// ── Output delivery (where an agent's results go when a run finishes) ─────────────

export type DeliveryChannel =
  | "inbox" | "email" | "slack" | "telegram" | "webhook"
  | "sms" | "whatsapp" | "twitter" | "linkedin" | "discord";

export interface DeliveryTarget {
  channel: DeliveryChannel;
  config?: Record<string, string>;
}

/** Where this agent's output is delivered when a run completes. Inbox is always included by the server. */
export async function getDelivery(agentId: string): Promise<DeliveryTarget[]> {
  const data = await apiFetch<{ deliverTo: DeliveryTarget[] }>(`/api/agents/${encodeURIComponent(agentId)}/delivery`);
  return data.deliverTo;
}

/** Replace this agent's delivery targets. Returns the persisted set. */
export async function setDelivery(agentId: string, targets: DeliveryTarget[]): Promise<DeliveryTarget[]> {
  const data = await apiFetch<{ deliverTo: DeliveryTarget[] }>(`/api/agents/${encodeURIComponent(agentId)}/delivery`, {
    method: "PUT",
    body: JSON.stringify({ deliverTo: targets }),
  });
  return data.deliverTo;
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
