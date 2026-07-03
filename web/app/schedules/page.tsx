"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import {
  listSchedules,
  listAgents,
  createSchedule,
  toggleSchedule,
  deleteSchedule,
  timeAgo,
  getCached,
  type ScheduleRecord,
  type AgentRecord,
} from "../../lib/api";

const CRON_PRESETS = [
  { label: "Every 15 minutes",    spec: "*/15 * * * *", kind: "cron" as const },
  { label: "Every hour",          spec: "0 * * * *",    kind: "cron" as const },
  { label: "Every day at 8am",    spec: "0 8 * * *",    kind: "cron" as const },
  { label: "Every Monday 9am",    spec: "0 9 * * 1",    kind: "cron" as const },
  { label: "Every 5 minutes",     spec: "300000",       kind: "interval" as const },
  { label: "Every 30 minutes",    spec: "1800000",      kind: "interval" as const },
];

type ScheduleState = "armed" | "enabled" | "paused";

function scheduleState(s: ScheduleRecord): ScheduleState {
  if (!s.enabled) return "paused";
  return s.armed ? "armed" : "enabled";
}

// armed/enabled are STATIC states (not actively running) → neutral, never amber.
// amber (--live) is reserved for live/running execution only.
const STATE_BADGE_CLASS: Record<ScheduleState, string> = {
  armed:   "badge badge-neutral",
  enabled: "badge badge-neutral",
  paused:  "badge badge-paused",
};

const STATE_LABEL: Record<ScheduleState, string> = {
  armed:   "armed",
  enabled: "enabled",
  paused:  "paused",
};

function formatSpec(kind: "cron" | "interval", spec: string): string {
  if (kind === "interval") {
    const ms = parseInt(spec, 10);
    if (isNaN(ms)) return spec;
    if (ms < 60_000) return `${ms}ms`;
    if (ms < 3_600_000) return `every ${ms / 60_000} min`;
    return `every ${ms / 3_600_000} h`;
  }
  return spec;
}

// Plain-English gloss for a cron expression — covers the common presets and a few
// general shapes, falling back gracefully. Display-only; never blocks the raw spec.
function describeCron(spec: string): string | null {
  const map: Record<string, string> = {
    "*/15 * * * *": "Runs every 15 minutes",
    "*/5 * * * *":  "Runs every 5 minutes",
    "0 * * * *":    "Runs at the top of every hour",
    "0 8 * * *":    "Runs every day at 8:00am",
    "0 9 * * 1":    "Runs every Monday at 9:00am",
    "0 0 * * *":    "Runs every day at midnight",
  };
  return map[spec.trim()] ?? null;
}

export default function SchedulesPage() {
  const cachedSchedules = getCached<ScheduleRecord[]>("schedules");
  const [schedules, setSchedules] = useState<ScheduleRecord[]>(cachedSchedules ?? []);
  const [agents, setAgents] = useState<AgentRecord[]>(getCached<AgentRecord[]>("agents") ?? []);
  const [loading, setLoading] = useState(!cachedSchedules);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);

  const load = useCallback(async () => {
    try {
      const [s, a] = await Promise.all([listSchedules(), listAgents()]);
      setSchedules(s);
      setAgents(a);
      setError(null);
    } catch (e) {
      setError((e as Error).message || "Could not reach the Krelvan API.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function handleToggle(id: string, enabled: boolean) {
    try {
      const updated = await toggleSchedule(id, enabled);
      setSchedules(prev => prev.map(s => s.id === id ? updated : s));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function handleDelete(id: string) {
    try {
      await deleteSchedule(id);
      setSchedules(prev => prev.filter(s => s.id !== id));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const activeCount = schedules.filter(s => s.enabled).length;
  const pausedCount = schedules.length - activeCount;
  // Soonest upcoming run across all enabled schedules — the next thing that fires.
  const nextUp = schedules
    .filter(s => s.enabled && s.nextRunAt != null)
    .map(s => s.nextRunAt as number)
    .sort((a, b) => a - b)[0];

  return (
    <div className="container" style={{ paddingTop: "var(--s8)", paddingBottom: "var(--s9)" }}>
      {/* ── page header: context · title · description · primary action ── */}
      <div
        style={{
          display: "flex", alignItems: "flex-start", justifyContent: "space-between",
          gap: "var(--s5)", flexWrap: "wrap", marginBottom: "var(--s6)",
        }}
      >
        <div style={{ minWidth: 0 }}>
          <p className="micro" style={{ marginBottom: "var(--s2)" }}>Automation</p>
          <h1 className="h1" style={{ marginBottom: "var(--s2)" }}>Schedules</h1>
          <p className="soft body-lg" style={{ margin: 0, maxWidth: "58ch" }}>
            Run an agent on its own — on a recurring cron expression or a fixed interval.
            Each scheduled run is recorded just like one you start by hand.
          </p>
        </div>
        <button
          className={showForm ? "btn btn-secondary" : "btn btn-primary"}
          style={{ flexShrink: 0 }}
          onClick={() => setShowForm(v => !v)}
        >
          {showForm ? "Cancel" : "+ New schedule"}
        </button>
      </div>

      {/* ── summary strip: only when schedules exist ── */}
      {!loading && schedules.length > 0 && (
        <div className="stat-strip" style={{ marginBottom: "var(--s6)" }}>
          <div className="stat-cell">
            <span className="stat-value">{schedules.length}</span>
            <span className="stat-label">schedules</span>
          </div>
          <div className="stat-cell">
            <span className="stat-value">{activeCount}</span>
            <span className="stat-label">active</span>
          </div>
          <div className="stat-cell">
            <span className="stat-value">{pausedCount}</span>
            <span className="stat-label">paused</span>
          </div>
          <div className="stat-cell">
            <span className="stat-value" style={{ fontSize: 15 }}>
              {nextUp != null ? timeAgo(nextUp) : "—"}
            </span>
            <span className="stat-label">next run</span>
          </div>
        </div>
      )}

      {/* ── error state ── */}
      {error && (
        <div role="alert" className="state-error" style={{ marginBottom: "var(--s6)", justifyContent: "space-between" }}>
          <span>{error}</span>
          <button
            onClick={() => void load()}
            className="btn btn-sm"
            style={{ background: "transparent", color: "var(--danger)", border: "1px solid var(--danger-ring)", flexShrink: 0 }}
          >
            Retry now
          </button>
        </div>
      )}

      {/* ── create form (inline, not modal) ── */}
      {showForm && (
        <CreateForm
          agents={agents}
          onCreated={(s) => { setSchedules(prev => [s, ...prev]); setShowForm(false); }}
          onError={setError}
          onCancel={() => setShowForm(false)}
        />
      )}

      {/* ── loading / empty / list ── */}
      {loading ? (
        <div className="state-loading">
          <span className="spinner" aria-hidden="true" />
          <span>Loading schedules…</span>
        </div>
      ) : schedules.length === 0 ? (
        <Empty hasAgents={agents.length > 0} onNew={() => setShowForm(true)} />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--s4)" }}>
          {schedules.map(s => (
            <ScheduleCard
              key={s.id}
              schedule={s}
              onToggle={handleToggle}
              onDelete={handleDelete}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ScheduleCard({
  schedule: s,
  onToggle,
  onDelete,
}: {
  schedule: ScheduleRecord;
  onToggle: (id: string, enabled: boolean) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}) {
  const [toggling, setToggling] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  async function handleToggle() {
    setToggling(true);
    await onToggle(s.id, !s.enabled);
    setToggling(false);
  }

  async function handleDelete() {
    setDeleting(true);
    await onDelete(s.id);
    setDeleting(false);
  }

  const state = scheduleState(s);
  const gloss = s.kind === "cron" ? describeCron(s.spec) : `Runs ${formatSpec("interval", s.spec)}`;

  return (
    <div
      className="card card-hover"
      style={{
        padding: "var(--s5)",
        display: "grid", gridTemplateColumns: "auto 1fr auto",
        gap: "var(--s5)", alignItems: "center",
        borderLeft: `3px solid ${s.enabled ? "var(--brand)" : "var(--line-strong)"}`,
        opacity: s.enabled ? 1 : 0.72,
        transition: "opacity var(--t-standard) var(--ease)",
      }}
    >
      {/* leading status dot — neutral/paused only; schedules are never "live" */}
      <span
        aria-hidden="true"
        style={{
          width: 10, height: 10, borderRadius: "50%", flexShrink: 0,
          background: s.enabled ? "var(--brand)" : "var(--paused)",
          boxShadow: s.enabled ? "0 0 0 4px var(--brand-ring)" : "none",
        }}
      />

      {/* main column */}
      <div style={{ minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: "var(--s3)", marginBottom: "var(--s2)", flexWrap: "wrap" }}>
          <span className="h3" style={{ color: "var(--ink)" }}>
            {s.label || formatSpec(s.kind, s.spec)}
          </span>
          <span className="badge badge-neutral mono" style={{ textTransform: "lowercase" }}>
            {s.kind}
          </span>
          <span className={STATE_BADGE_CLASS[state]}>
            {STATE_LABEL[state]}
          </span>
        </div>

        {/* the spec — the source of truth, in mono — with a plain-English gloss */}
        <div style={{ display: "flex", alignItems: "center", gap: "var(--s3)", flexWrap: "wrap", marginBottom: "var(--s3)" }}>
          <code
            className="mono small"
            style={{
              padding: "2px var(--s2)", borderRadius: "var(--r-sm)",
              background: "var(--surface-sunken)", border: "1px solid var(--line)",
              color: "var(--ink-soft)",
            }}
          >
            {formatSpec(s.kind, s.spec)}
          </code>
          {gloss && <span className="small muted">{gloss}</span>}
        </div>

        <div className="small muted" style={{ display: "flex", gap: "var(--s5)", flexWrap: "wrap", alignItems: "center" }}>
          <span>
            Agent:{" "}
            <Link href={`/agents/${s.agentId}`} style={{ fontWeight: 500 }}>{s.agentName}</Link>
          </span>
          <span>
            Last run:{" "}
            {s.lastRunAt
              ? (s.lastRunId
                  ? <Link href={`/runs/${s.lastRunId}`} className="mono" style={{ fontWeight: 500 }}>{timeAgo(s.lastRunAt)}</Link>
                  : <span className="mono">{timeAgo(s.lastRunAt)}</span>)
              : <span className="mono">never</span>}
          </span>
          {s.enabled && s.nextRunAt != null && (
            <span>
              Next run:{" "}
              <span className="mono" style={{ color: "var(--ink-soft)", fontWeight: 500 }}>
                {timeAgo(s.nextRunAt)}
              </span>
              <span className="mono" style={{ color: "var(--ink-muted)" }}>
                {" "}· {new Date(s.nextRunAt).toLocaleTimeString()}
              </span>
            </span>
          )}
          {!s.enabled && <span className="mono">Paused — will not run</span>}
        </div>
      </div>

      {/* actions */}
      <div style={{ display: "flex", gap: "var(--s2)", alignItems: "center", justifySelf: "end" }}>
        {!confirmDelete ? (
          <>
            <button
              className="btn btn-sm btn-secondary"
              disabled={toggling}
              onClick={() => void handleToggle()}
            >
              {toggling ? "…" : s.enabled ? "Pause" : "Enable"}
            </button>
            <button
              className="btn btn-sm btn-danger"
              onClick={() => setConfirmDelete(true)}
            >
              Delete
            </button>
          </>
        ) : (
          <div style={{ display: "flex", alignItems: "center", gap: "var(--s2)" }}>
            <span className="micro" style={{ color: "var(--danger)", whiteSpace: "nowrap" }}>Delete?</span>
            <button
              className="btn btn-sm btn-secondary"
              onClick={() => setConfirmDelete(false)}
            >
              Cancel
            </button>
            <button
              className="btn btn-sm btn-danger"
              disabled={deleting}
              onClick={() => void handleDelete()}
            >
              {deleting ? "…" : "Yes, delete"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function CreateForm({
  agents,
  onCreated,
  onError,
  onCancel,
}: {
  agents: AgentRecord[];
  onCreated: (s: ScheduleRecord) => void;
  onError: (e: string) => void;
  onCancel: () => void;
}) {
  const [agentId, setAgentId] = useState(agents[0]?.id ?? "");
  const [kind, setKind] = useState<"cron" | "interval">("cron");
  const [spec, setSpec] = useState("0 8 * * *");
  const [label, setLabel] = useState("");
  const [saving, setSaving] = useState(false);

  function applyPreset(preset: typeof CRON_PRESETS[number]) {
    setKind(preset.kind);
    setSpec(preset.spec);
    setLabel(preset.label);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!agentId) { onError("Select an agent to schedule."); return; }
    setSaving(true);
    try {
      const s = await createSchedule({ agentId, kind, spec, label: label || undefined });
      onCreated(s);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const noAgents = agents.length === 0;

  return (
    <div className="card" style={{ padding: "var(--s6)", marginBottom: "var(--s6)", boxShadow: "var(--shadow-md)" }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: "var(--s4)", marginBottom: "var(--s5)" }}>
        <h2 className="h2">New schedule</h2>
        <span className="small muted">Pick an agent, choose how often, give it a name.</span>
      </div>

      {noAgents && (
        <div className="state-error" role="alert" style={{ marginBottom: "var(--s5)", background: "var(--info-tint)", color: "var(--info)", borderColor: "transparent" }}>
          <span>You need an agent before you can schedule one. <Link href="/" style={{ color: "var(--info)", fontWeight: 600 }}>Build an agent →</Link></span>
        </div>
      )}

      {/* How a scheduled run interacts with approvals — set the expectation before they create one. */}
      <p className="small muted" style={{ margin: "0 0 var(--s5)", maxWidth: "68ch", lineHeight: 1.55 }}>
        A scheduled run that hits a step needing approval pauses and waits for you in{" "}
        <Link href="/approvals" style={{ color: "var(--brand)", fontWeight: 500 }}>Approvals</Link> — it won&apos;t act unattended until you decide.
      </p>

      {/* quick presets */}
      <div style={{ marginBottom: "var(--s5)" }}>
        <p className="micro" style={{ marginBottom: "var(--s3)" }}>Quick presets</p>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--s2)" }}>
          {CRON_PRESETS.map(p => {
            const active = spec === p.spec;
            return (
              <button
                key={p.spec}
                type="button"
                className="chip"
                onClick={() => applyPreset(p)}
                style={active ? {
                  background: "var(--brand-tint)",
                  color: "var(--brand)",
                  borderColor: "var(--brand)",
                } : undefined}
              >
                {p.label}
              </button>
            );
          })}
        </div>
      </div>

      <form onSubmit={(e) => void handleSubmit(e)} style={{ display: "flex", flexDirection: "column", gap: "var(--s5)" }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--s4)" }}>
          <label style={{ display: "flex", flexDirection: "column", gap: "var(--s2)" }}>
            <span className="micro">Agent</span>
            <select
              className="input"
              value={agentId}
              onChange={e => setAgentId(e.target.value)}
            >
              {noAgents
                ? <option value="">No agents yet</option>
                : agents.map(a => (
                    <option key={a.id} value={a.id}>{a.signed.manifest.name}</option>
                  ))}
            </select>
          </label>

          <div style={{ display: "flex", flexDirection: "column", gap: "var(--s2)" }}>
            <span className="micro">How often</span>
            <div className="segmented" role="group" aria-label="Schedule type" style={{ width: "fit-content" }}>
              <button
                type="button"
                className={kind === "cron" ? "is-active" : ""}
                aria-pressed={kind === "cron"}
                onClick={() => { setKind("cron"); setSpec("0 8 * * *"); }}
              >
                Cron
              </button>
              <button
                type="button"
                className={kind === "interval" ? "is-active" : ""}
                aria-pressed={kind === "interval"}
                onClick={() => { setKind("interval"); setSpec("3600000"); }}
              >
                Interval
              </button>
            </div>
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--s4)" }}>
          <label style={{ display: "flex", flexDirection: "column", gap: "var(--s2)" }}>
            <span className="micro">{kind === "cron" ? "Cron expression" : "Interval (ms)"}</span>
            <input
              type="text"
              className="input input-mono"
              value={spec}
              onChange={e => setSpec(e.target.value)}
              placeholder={kind === "cron" ? "0 8 * * *" : "3600000"}
            />
            <span className="mono small muted">
              {kind === "cron"
                ? (describeCron(spec) ?? "min  hour  day  month  weekday")
                : `= ${formatSpec("interval", spec)}`}
            </span>
          </label>

          <label style={{ display: "flex", flexDirection: "column", gap: "var(--s2)" }}>
            <span className="micro">Label (optional)</span>
            <input
              type="text"
              className="input"
              value={label}
              onChange={e => setLabel(e.target.value)}
              placeholder="e.g. Daily morning digest"
            />
            <span className="small muted">A friendly name for this schedule.</span>
          </label>
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: "var(--s3)", borderTop: "1px solid var(--line)", paddingTop: "var(--s5)" }}>
          <button type="button" className="btn btn-secondary" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={saving || noAgents}>
            {saving ? "Creating…" : "Create schedule"}
          </button>
        </div>
      </form>
    </div>
  );
}

function Empty({ hasAgents, onNew }: { hasAgents: boolean; onNew: () => void }) {
  return (
    <div className="state-empty" style={{ padding: "var(--s9) var(--s6)", gap: "var(--s4)" }}>
      <div
        aria-hidden="true"
        style={{
          width: 56, height: 56, borderRadius: "var(--r-lg)",
          display: "flex", alignItems: "center", justifyContent: "center",
          background: "var(--brand-tint)", color: "var(--brand)",
        }}
      >
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <circle cx="12" cy="13" r="8" stroke="currentColor" strokeWidth="1.6" />
          <path d="M12 9v4l2.5 2M9 2.5h6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      </div>
      <div className="h2" style={{ color: "var(--ink)" }}>No schedules yet</div>
      <div className="body-lg soft" style={{ maxWidth: "46ch" }}>
        {hasAgents
          ? "Create your first schedule and an agent will start running on its own."
          : "Build an agent first, then schedule it to run on its own."}
      </div>
      <p className="small muted" style={{ maxWidth: "46ch", margin: 0 }}>
        A scheduled run that needs approval pauses and waits for you — it never acts unattended.
      </p>
      {hasAgents ? (
        <button className="btn btn-primary" style={{ marginTop: "var(--s2)" }} onClick={onNew}>
          + New schedule
        </button>
      ) : (
        <Link href="/" className="btn btn-primary" style={{ marginTop: "var(--s2)" }}>
          Build an agent first →
        </Link>
      )}
    </div>
  );
}
