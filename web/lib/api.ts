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

/** A schedule the builder detected from the intent — shown for confirmation, never auto-applied. */
export interface ScheduleProposal {
  kind: "cron" | "interval";
  spec: string;
  label: string;
  onMissed: "skip" | "runOnce";
}

export interface BuildResult {
  agent: AgentRecord;
  attempts: number;
  warnings: string[];
  /** present when the intent described a recurring schedule (C3). */
  schedule?: ScheduleProposal;
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

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json", ...(init?.headers as Record<string, string> | undefined) };
  // Attach the CSRF token (issued at login, kept in sessionStorage) on state-changing calls.
  const method = (init?.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD" && typeof window !== "undefined") {
    let csrf = sessionStorage.getItem("krelvan_csrf");
    // Rehydrate: a new tab / reopened tab of a still-valid session has empty sessionStorage, so a
    // write would 403. Fetch /auth/status once — it re-issues a CSRF token for a valid session —
    // and cache it, so the customer's Save works instead of returning a raw 403.
    if (!csrf) {
      try {
        const s = await fetch(`${API_BASE}/api/auth/status`, { cache: "no-store" }).then((r) => r.json()).catch(() => null) as { csrf?: string } | null;
        if (s && typeof s.csrf === "string") { csrf = s.csrf; sessionStorage.setItem("krelvan_csrf", csrf); }
      } catch { /* best-effort; server still enforces */ }
    }
    if (csrf) headers["X-CSRF-Token"] = csrf;
  }
  const res = await fetch(`${API_BASE}${path}`, { ...init, headers });
  // A 401 (session expired) OR a 429 (per-IP auth lockout) inside the authenticated app both mean
  // the same thing to the customer: their credentials are no longer being accepted and the only
  // recovery is to sign in again. We treat them identically so a polling page (the dashboard
  // reloads every 3s) STOPS hammering a guarded endpoint and bounces to login instead of looping
  // on a dead-end "too many failed attempts" banner with no way out. The 429 here can only come
  // from the auth brute-force lockout — a valid session takes the clear-fails fast-path and is
  // never counted — so redirecting is safe. PUBLIC pages (marketing homepage, login, setup, share)
  // intentionally make API calls that may 401 for a logged-out visitor and must degrade gracefully,
  // never redirect THOSE to login, or a visitor can never see the homepage.
  if ((res.status === 401 || res.status === 429) && typeof window !== "undefined") {
    const p = window.location.pathname;
    // Keep this in sync with middleware PUBLIC_PATHS. /faq is a public marketing page — a
    // logged-out visitor's FAQ API calls may 401 and must degrade gracefully, NOT bounce the
    // whole window to /login (that made clicking "FAQ" from the nav a dead-end sign-in wall).
    const isPublic = p === "/" || p === "/faq" || p === "/marketplace" || p.startsWith("/login") || p.startsWith("/setup") || p.startsWith("/share/") || p.startsWith("/r/") || p.startsWith("/a/");
    if (!isPublic) {
      // If a session cookie is present but the server rejects us, the session likely ended (e.g. the
      // server restarted — sessions are in-memory) or the IP tripped the lockout after it ended.
      // Tell the customer why instead of a bare login.
      sessionStorage.removeItem("krelvan_csrf");
      window.location.href = "/login?reason=session-ended";
    }
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText })) as { error?: string; code?: string };
    throw new ApiError(err.error ?? `API error ${res.status}`, res.status, err.code);
  }
  return res.json() as Promise<T>;
}

export interface AuthStatus {
  setupNeeded: boolean;
  authenticated: boolean;
  csrf?: string;
}

/** Public, read-only session check. This must run before a public page calls protected APIs. */
export async function getAuthStatus(): Promise<AuthStatus> {
  const status = await apiFetch<AuthStatus>("/api/auth/status");
  if (typeof window !== "undefined" && status.csrf) {
    sessionStorage.setItem("krelvan_csrf", status.csrf);
  }
  return status;
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

export interface ModelStatus { hasLlm: boolean; provider: string; model?: string | null; source?: "in-app" | "env"; serverTz?: string }
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

export async function deleteRun(runId: string): Promise<void> {
  await apiFetch(`/api/runs/${encodeURIComponent(runId)}`, { method: "DELETE" });
}

export async function clearRuns(agentId?: string): Promise<{ removed: number }> {
  return apiFetch<{ removed: number }>("/api/runs/clear", {
    method: "POST",
    body: JSON.stringify(agentId ? { agentId } : {}),
  });
}

export async function explainBuild(agentId: string): Promise<{ rationale: string; generatedAt: number; agentId: string }> {
  return apiFetch(`/api/agents/${encodeURIComponent(agentId)}/explain-build`);
}

/**
 * Converse with an agent from the UI. Sends a message plus the prior thread history
 * (a plain "User: …\nAgent: …" transcript) and returns the agent's reply. A run is
 * executed server-side, so this takes a few seconds.
 */
export async function chatWithAgent(
  agentId: string,
  message: string,
  threadId: string,
  history: string,
): Promise<{ reply: string; runId: string; status: string; threadId: string }> {
  return apiFetch<{ reply: string; runId: string; status: string; threadId: string }>(
    `/api/agents/${encodeURIComponent(agentId)}/chat`,
    { method: "POST", body: JSON.stringify({ message, threadId, history }) },
  );
}

export async function listRuns(): Promise<RunRecord[]> {
  const data = await apiFetch<{ runs: RunRecord[] }>("/api/runs");
  listCache.set("runs", data.runs);
  return data.runs;
}

/** Start a run. `input` is an optional free-text message the agent receives (the text to process,
 *  the question to answer) — seeded so agents that need input actually get it. */
export async function startRun(agentId: string, input?: string): Promise<RunRecord> {
  const data = await apiFetch<{ run: RunRecord }>("/api/runs", {
    method: "POST",
    body: JSON.stringify(input && input.trim() ? { agentId, message: input } : { agentId }),
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

// ── Artifacts (the consume side) ────────────────────────────────────────────────

export interface ArtifactRecord {
  id: string;
  agentId: string;
  agentName: string;
  runId: string;
  scheduleId?: string;
  title: string;
  body: string;
  format: "markdown" | "text";
  createdAt: number;
  archived: boolean;
  readAt?: number;
  shareTokenHash?: string;
  published?: boolean;
}

/** Admin public-config view for an agent (the toggle UI checks feedEnabled). */
export interface AgentPublicView {
  slug?: string;
  publicUrl: string | null;
  enabled: boolean;
  showFeed: boolean;
  chat: boolean;
  hasSiteKey: boolean;
  allowedOrigins?: string[];
  siteKey?: string;
  note?: string;
}

export async function getAgentPublic(agentId: string): Promise<AgentPublicView> {
  return apiFetch<AgentPublicView>(`/api/agents/${encodeURIComponent(agentId)}/public`);
}

/** Update an agent's public config. Returns the view (+ siteKey ONCE when chat is first enabled). */
export async function setAgentPublic(agentId: string, cfg: { enabled: boolean; showFeed: boolean; chat: boolean; allowedOrigins?: string[] }): Promise<AgentPublicView> {
  return apiFetch<AgentPublicView>(`/api/agents/${encodeURIComponent(agentId)}/public`, { method: "PUT", body: JSON.stringify(cfg) });
}

/** Rotate the site key (invalidates the old one). Returns the new key ONCE. */
export async function rotateSiteKey(agentId: string): Promise<{ siteKey: string }> {
  return apiFetch<{ siteKey: string }>(`/api/agents/${encodeURIComponent(agentId)}/public/rotate-key`, { method: "POST" });
}

/** The public share payload — deliberately NO runId / internal ids. */
export interface SharedArtifact {
  title: string;
  body: string;
  format: "markdown" | "text";
  agentName: string;
  createdAt: number;
}

export interface ArtifactQuery {
  agentId?: string;
  runId?: string;
  archived?: boolean;
  q?: string;
  limit?: number;
  before?: number;
}

export async function listArtifacts(query: ArtifactQuery = {}): Promise<ArtifactRecord[]> {
  const p = new URLSearchParams();
  if (query.agentId) p.set("agentId", query.agentId);
  if (query.runId) p.set("runId", query.runId);
  if (query.archived !== undefined) p.set("archived", String(query.archived));
  if (query.q) p.set("q", query.q);
  if (query.limit !== undefined) p.set("limit", String(query.limit));
  if (query.before !== undefined) p.set("before", String(query.before));
  const qs = p.toString();
  const data = await apiFetch<{ artifacts: ArtifactRecord[] }>(`/api/artifacts${qs ? `?${qs}` : ""}`);
  listCache.set("artifacts", data.artifacts);
  return data.artifacts;
}

export async function getArtifact(id: string): Promise<{ artifact: ArtifactRecord; shared: boolean }> {
  return apiFetch<{ artifact: ArtifactRecord; shared: boolean }>(`/api/artifacts/${encodeURIComponent(id)}`);
}

export async function patchArtifact(id: string, patch: { archived?: boolean; read?: boolean; published?: boolean }): Promise<ArtifactRecord> {
  const data = await apiFetch<{ artifact: ArtifactRecord }>(`/api/artifacts/${encodeURIComponent(id)}`, {
    method: "PATCH", body: JSON.stringify(patch),
  });
  return data.artifact;
}

export async function deleteArtifact(id: string): Promise<void> {
  await apiFetch(`/api/artifacts/${encodeURIComponent(id)}`, { method: "DELETE" });
}

/** Mint (or rotate) a public share link. Returns the one-time token + its /share URL. */
export async function shareArtifact(id: string): Promise<{ token: string; url: string }> {
  return apiFetch<{ token: string; url: string }>(`/api/artifacts/${encodeURIComponent(id)}/share`, { method: "POST" });
}

export async function unshareArtifact(id: string): Promise<{ revoked: boolean }> {
  return apiFetch<{ revoked: boolean }>(`/api/artifacts/${encodeURIComponent(id)}/share`, { method: "DELETE" });
}

/** Fetch a PUBLIC shared artifact. Used by the /share/[token] page — no session, no redirect. */
export async function getSharedArtifact(token: string): Promise<SharedArtifact> {
  const res = await fetch(`${API_BASE}/api/share/${encodeURIComponent(token)}`, { cache: "no-store" });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText })) as { error?: string };
    throw new Error(err.error ?? `not found`);
  }
  return res.json() as Promise<SharedArtifact>;
}

// ── Run one-pager (plain-English, shareable) ────────────────────────────────────

export interface SharedRun {
  agentName: string;
  agentSlug: string | null;
  status: string;
  explanation: string;
  createdAt: number;
  sharedAt: number;
}

/** Mint (or rotate) a "share this run" link. Generates the plain-English one-pager server-side
 *  and returns the one-time token + its /r URL. */
export async function shareRun(runId: string): Promise<{ token: string; url: string }> {
  return apiFetch<{ token: string; url: string }>(`/api/runs/${encodeURIComponent(runId)}/share`, { method: "POST" });
}

/** Revoke a run's share link (and drop the cached one-pager). */
export async function unshareRun(runId: string): Promise<{ revoked: boolean }> {
  return apiFetch<{ revoked: boolean }>(`/api/runs/${encodeURIComponent(runId)}/share`, { method: "DELETE" });
}

/** Fetch a PUBLIC shared run one-pager. Used by the /r/[token] page — no session, no redirect. */
export async function getSharedRun(token: string): Promise<SharedRun> {
  const res = await fetch(`${API_BASE}/api/run-share/${encodeURIComponent(token)}`, { cache: "no-store" });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText })) as { error?: string };
    throw new Error(err.error ?? `not found`);
  }
  return res.json() as Promise<SharedRun>;
}

// ── Public agent front door (B3) — all go through the proxy but need NO session; a 404
//    (agent private/disabled) is expected and must NOT redirect to login. ─────────────

export interface PublicAgentProfile { name: string; intent: string; chatEnabled: boolean; feedEnabled: boolean; siteKey?: string }
export interface PublicFeedItem { title: string; body: string; createdAt: number }

/** GET a public agent's profile by slug. Throws on 404 (disabled/absent). Public — no redirect. */
export async function getPublicAgent(slug: string): Promise<PublicAgentProfile> {
  const res = await fetch(`${API_BASE}/api/public/agents/${encodeURIComponent(slug)}`, { cache: "no-store" });
  if (!res.ok) throw new Error("not found");
  return res.json() as Promise<PublicAgentProfile>;
}

/** GET a public agent's published-artifact feed (404 when the feed is off). */
export async function getPublicFeed(slug: string): Promise<PublicFeedItem[]> {
  const res = await fetch(`${API_BASE}/api/public/agents/${encodeURIComponent(slug)}/feed`, { cache: "no-store" });
  if (!res.ok) throw new Error("not found");
  const data = await res.json() as { items: PublicFeedItem[] };
  return data.items;
}

export type PublicAskResult =
  | { status: "reply"; reply: string; thread: string }
  | { status: "pending"; thread: string; poll: string }
  | { status: "awaiting-approval"; thread: string }
  | { status: "rate-limited" }
  | { status: "error"; message: string };

/** POST a public chat turn (site-key-authed). Returns the reply, a 202 status, or an error. */
export async function publicAsk(slug: string, message: string, siteKey: string, thread?: string): Promise<PublicAskResult> {
  const res = await fetch(`${API_BASE}/api/public/agents/${encodeURIComponent(slug)}/ask`, {
    method: "POST", headers: { "content-type": "application/json" }, cache: "no-store",
    body: JSON.stringify({ message, siteKey, ...(thread ? { thread } : {}) }),
  });
  const body = await res.json().catch(() => ({})) as Record<string, unknown>;
  if (res.status === 200) return { status: "reply", reply: String(body["reply"] ?? ""), thread: String(body["thread"] ?? "") };
  if (res.status === 202 && body["status"] === "awaiting-approval") return { status: "awaiting-approval", thread: String(body["thread"] ?? "") };
  if (res.status === 202) return { status: "pending", thread: String(body["thread"] ?? ""), poll: String(body["poll"] ?? "") };
  if (res.status === 429) return { status: "rate-limited" };
  return { status: "error", message: String(body["error"] ?? "could not reach the agent") };
}

/** Poll a pending public ask thread. */
export async function publicAskPoll(slug: string, thread: string): Promise<PublicAskResult> {
  const res = await fetch(`${API_BASE}/api/public/agents/${encodeURIComponent(slug)}/ask/${encodeURIComponent(thread)}`, { cache: "no-store" });
  const body = await res.json().catch(() => ({})) as Record<string, unknown>;
  if (res.status === 200) return { status: "reply", reply: String(body["reply"] ?? ""), thread };
  if (res.status === 202 && body["status"] === "awaiting-approval") return { status: "awaiting-approval", thread };
  if (res.status === 202) return { status: "pending", thread, poll: "" };
  return { status: "error", message: String(body["error"] ?? "not found") };
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
  // Explanations require a model. Check once up front so an instance without a
  // configured provider does not create a burst of predictable 503 responses.
  void getStatus()
    .then(status => {
      if (cancelled) return;
      if (status.hasLlm) {
        pump();
        return;
      }
      queue.forEach(runId => onSummary(runId, ""));
    })
    .catch(() => {
      if (!cancelled) queue.forEach(runId => onSummary(runId, ""));
    });
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

// ── Rehearsal Room: run synthetic users against the real graph, faked world ──────

export type RehearsalVerdict = "completed" | "parked" | "looped" | "failed";
export type FindingLevel = "ok" | "warn" | "stop";
export interface RehearsalFinding { level: FindingLevel; code: string; message: string; }
export interface RehearsalPersona { name: string; description: string; seedMessage: string; }
export interface RehearsalPersonaResult {
  persona: RehearsalPersona;
  runId: string;
  judgement: { verdict: RehearsalVerdict; findings: RehearsalFinding[] };
}
export interface RehearsalReport {
  rehearsalId: string;
  agentId: string;
  agentName: string;
  createdAt: number;
  personasGenerated: boolean;
  results: RehearsalPersonaResult[];
  rollup: {
    total: number;
    byVerdict: Record<RehearsalVerdict, number>;
    findingCounts: Record<FindingLevel, number>;
    headline: RehearsalFinding | null;
    hasBlocker: boolean;
  };
}

/** Rehearse an agent: cast synthetic users, run each on the real graph with a faked world, and
 *  return a report. Nothing is delivered, charged, or written. May take a while (many runs). */
export async function rehearseAgent(agentId: string, count?: number): Promise<RehearsalReport> {
  const data = await apiFetch<{ report: RehearsalReport }>(`/api/agents/${encodeURIComponent(agentId)}/rehearse`, {
    method: "POST",
    body: JSON.stringify(count ? { count } : {}),
  });
  return data.report;
}

/**
 * Deterministically build a TESTER agent for this agent (agent-tests-agent): it casts synthetic
 * users, runs each through THIS agent, judges, and reports. Returns the new tester agent's id so
 * the caller can navigate to run it. No LLM assembly — reliable on any model.
 */
export async function testAgent(agentId: string, count?: number): Promise<{ agentId: string; name: string }> {
  return apiFetch<{ agentId: string; name: string }>(`/api/agents/${encodeURIComponent(agentId)}/test`, {
    method: "POST",
    body: JSON.stringify(count ? { count } : {}),
  });
}

// ── Visible self-improvement: propose a fix, show the diff, then accept ──────────

export interface ManifestDiff {
  identical: boolean;
  addedNodes: { id: string; role: string; capabilities: string[] }[];
  removedNodes: { id: string; role: string }[];
  changedNodes: { id: string; changes: string[] }[];
  addedEdges: { from: string; to: string }[];
  removedEdges: { from: string; to: string }[];
  fieldChanges: { field: string; before: string; after: string }[];
}

export interface FixProposal {
  proposedAgentId: string;
  proposedAgentName: string;
  fixStrategy: string;
  failReason: string;
  basedOnRun: string;
  diff: ManifestDiff;
}

/** Propose a corrected agent for a failed run WITHOUT running it — returns the fix + a
 *  before→after manifest diff for the owner to review. Accept via startRun(proposedAgentId). */
export async function proposeFix(runId: string, fixStrategy?: string): Promise<FixProposal> {
  return apiFetch<FixProposal>(`/api/runs/${encodeURIComponent(runId)}/propose-fix`, {
    method: "POST",
    body: JSON.stringify(fixStrategy ? { fixStrategy } : {}),
  });
}

export interface ForkResult { run: RunRecord; forkedFrom: string; throughNodeId: string; edited: boolean; }
/**
 * Time-travel: fork a run at a chosen node and re-run forward from there. Optionally override one
 * of that node's outputs (`edit`) to explore a what-if. Returns the new run to navigate to.
 */
export async function forkRun(
  runId: string,
  throughNodeId: string,
  edit?: { key: string; value: string | number | boolean | null },
): Promise<ForkResult> {
  return apiFetch<ForkResult>(`/api/runs/${encodeURIComponent(runId)}/fork`, {
    method: "POST",
    body: JSON.stringify(edit ? { throughNodeId, edit } : { throughNodeId }),
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
  onMissed?: "skip" | "runOnce";
  lastStatus?: "completed" | "failed" | "halted";
  failStreak?: number;
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
  onMissed?: "skip" | "runOnce";
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

/** Fire a schedule now, through the schedule path so the run is attributed to it. */
export async function runScheduleNow(id: string): Promise<{ runId: string }> {
  return apiFetch<{ runId: string }>(`/api/schedules/${id}/run`, { method: "POST" });
}

/** One row of a schedule's run history — a run + the artifact it produced (if any). */
export interface ScheduleRun extends RunRecord {
  agentName: string;
  artifactId?: string;
  origin?: { kind: string; scheduleId?: string };
}

/** The last runs this schedule fired (newest-first), for the expandable history. */
export async function getScheduleRuns(id: string): Promise<ScheduleRun[]> {
  const data = await apiFetch<{ runs: ScheduleRun[] }>(`/api/schedules/${encodeURIComponent(id)}/runs`);
  return data.runs;
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

// ── Connections (per-user channel connect flows) ────────────────────────────────

export interface TelegramConnection {
  connected: boolean;
  botUsername?: string;
  chatName?: string;
}

/** Whether this instance has a Telegram bot connected, plus display metadata. */
export async function getTelegramConnection(): Promise<TelegramConnection> {
  return apiFetch<TelegramConnection>("/api/connections/telegram");
}

export type ConnectTelegramResult =
  | { ok: true; botUsername: string; chatId: number; chatName: string }
  | { ok: false; needsMessage: true; botUsername: string };

/**
 * Connect the customer's own Telegram bot. Validates the token, auto-detects the chat
 * from the latest message, and stores the token encrypted server-side. The token is never
 * echoed back. If no message exists yet, returns { ok:false, needsMessage:true } so the UI
 * can ask the user to message their bot and retry.
 */
export async function connectTelegram(token: string): Promise<ConnectTelegramResult> {
  return apiFetch<ConnectTelegramResult>("/api/connections/telegram", {
    method: "POST",
    body: JSON.stringify({ token }),
  });
}

/** Disconnect Telegram — removes the stored token, chat id, and metadata. */
export async function disconnectTelegram(): Promise<void> {
  await apiFetch("/api/connections/telegram", { method: "DELETE" });
}

export interface EmailConnection {
  connected: boolean;
  from?: string;
}

/** Whether this instance has email (Resend) connected, plus the sender address. */
export async function getEmailConnection(): Promise<EmailConnection> {
  return apiFetch<EmailConnection>("/api/connections/email");
}

/**
 * Connect email delivery with the customer's own Resend API key. Validates the key against
 * Resend, then stores it encrypted server-side (never echoed back). `from` is optional — if
 * omitted, Resend's shared onboarding sender is used so email works with no domain setup.
 */
export async function connectEmail(apiKey: string, from?: string): Promise<{ ok: true; from: string }> {
  return apiFetch<{ ok: true; from: string }>("/api/connections/email", {
    method: "POST",
    body: JSON.stringify({ apiKey, ...(from ? { from } : {}) }),
  });
}

/** Disconnect email — removes the stored Resend key and sender. */
export async function disconnectEmail(): Promise<void> {
  await apiFetch("/api/connections/email", { method: "DELETE" });
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
