"use client";

import { useState, useEffect, useCallback } from "react";
import {
  listSchedules,
  listAgents,
  createSchedule,
  toggleSchedule,
  deleteSchedule,
  timeAgo,
  type ScheduleRecord,
  type AgentRecord,
} from "../../lib/api";

const CRON_PRESETS = [
  { label: "Every day at 8am",    spec: "0 8 * * *",    kind: "cron" as const },
  { label: "Every hour",          spec: "0 * * * *",    kind: "cron" as const },
  { label: "Every 15 minutes",    spec: "*/15 * * * *", kind: "cron" as const },
  { label: "Every Monday 9am",    spec: "0 9 * * 1",    kind: "cron" as const },
  { label: "Every 5 minutes",     spec: "300000",        kind: "interval" as const },
  { label: "Every 30 minutes",    spec: "1800000",       kind: "interval" as const },
];

function formatSpec(kind: "cron" | "interval", spec: string): string {
  if (kind === "interval") {
    const ms = parseInt(spec, 10);
    if (isNaN(ms)) return spec;
    if (ms < 60_000) return `${ms}ms`;
    if (ms < 3_600_000) return `every ${ms / 60_000}min`;
    return `every ${ms / 3_600_000}h`;
  }
  return spec;
}

export default function SchedulesPage() {
  const [schedules, setSchedules] = useState<ScheduleRecord[]>([]);
  const [agents, setAgents] = useState<AgentRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);

  const load = useCallback(async () => {
    try {
      const [s, a] = await Promise.all([listSchedules(), listAgents()]);
      setSchedules(s);
      setAgents(a);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
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

  return (
    <div className="container" style={{ paddingTop: "var(--s7)", paddingBottom: "var(--s9)" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "var(--s6)" }}>
        <div>
          <h1 className="h1" style={{ marginBottom: "var(--s2)" }}>Schedules</h1>
          <p className="soft" style={{ fontSize: 14, margin: 0 }}>
            Run agents automatically — on a cron expression or a fixed interval.
          </p>
        </div>
        <button className="btn btn-primary" onClick={() => setShowForm(v => !v)}>
          {showForm ? "Cancel" : "New schedule"}
        </button>
      </div>

      {error && (
        <div style={{
          padding: "var(--s4) var(--s5)", marginBottom: "var(--s6)",
          background: "var(--danger-tint)", border: "1px solid rgba(185,28,28,.2)", borderRadius: "var(--r)",
          color: "var(--danger)", fontSize: 13,
        }}>
          {error}
        </div>
      )}

      {showForm && (
        <CreateForm
          agents={agents}
          onCreated={(s) => { setSchedules(prev => [s, ...prev]); setShowForm(false); }}
          onError={setError}
        />
      )}

      {loading ? (
        <div className="soft small" style={{ padding: "var(--s7)" }}>Loading…</div>
      ) : schedules.length === 0 ? (
        <Empty />
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

  return (
    <div style={{
      background: "var(--surface)", border: "1px solid var(--line)",
      borderRadius: "var(--r)", padding: "var(--s5)",
      display: "grid", gridTemplateColumns: "1fr auto",
      gap: "var(--s4)", alignItems: "start",
      opacity: s.enabled ? 1 : 0.6,
      transition: "opacity 200ms",
    }}>
      <div>
        <div style={{ display: "flex", alignItems: "center", gap: "var(--s3)", marginBottom: "var(--s2)", flexWrap: "wrap" }}>
          <span style={{ fontWeight: 600, fontSize: 14 }}>{s.label || formatSpec(s.kind, s.spec)}</span>
          <span style={{
            fontSize: 11, fontWeight: 600, fontFamily: "var(--font-mono)",
            padding: "2px 8px", borderRadius: "var(--r-pill)",
            background: s.kind === "cron" ? "var(--brand-tint)" : "var(--ok-tint)",
            color: s.kind === "cron" ? "var(--brand)" : "var(--ok)",
          }}>
            {s.kind}
          </span>
          <span style={{
            fontSize: 11, padding: "2px 8px", borderRadius: "var(--r-pill)",
            background: s.enabled && s.armed ? "var(--live-tint)" : "var(--brand-tint)",
            color: s.enabled && s.armed ? "var(--live)" : "var(--ink-soft)",
            fontWeight: 600,
          }}>
            {s.enabled && s.armed ? "armed" : s.enabled ? "enabled" : "paused"}
          </span>
        </div>

        <div style={{ fontFamily: "var(--font-mono)", fontSize: 13, color: "var(--ink-soft)", marginBottom: "var(--s3)" }}>
          {formatSpec(s.kind, s.spec)}
        </div>

        <div style={{ display: "flex", gap: "var(--s5)", fontSize: 12, color: "var(--ink-muted)", flexWrap: "wrap" }}>
          <span>Agent: <a href={`/agents/${s.agentId}`} style={{ color: "var(--brand)", fontWeight: 500 }}>{s.agentName}</a></span>
          {s.lastRunAt && <span>Last run: {timeAgo(s.lastRunAt)}</span>}
          {s.nextRunAt && s.enabled && (
            <span>Next: {timeAgo(s.nextRunAt)} ({new Date(s.nextRunAt).toLocaleTimeString()})</span>
          )}
        </div>
      </div>

      <div style={{ display: "flex", gap: "var(--s2)", alignItems: "center" }}>
        {!confirmDelete ? (
          <>
            <button
              className="btn btn-sm btn-secondary"
              disabled={toggling}
              onClick={() => void handleToggle()}
              style={{ opacity: toggling ? .6 : 1 }}
            >
              {toggling ? "…" : s.enabled ? "Pause" : "Enable"}
            </button>
            <button
              className="btn btn-sm"
              style={{ color: "var(--danger)", borderColor: "rgba(185,28,28,.25)" }}
              onClick={() => setConfirmDelete(true)}
            >
              Delete
            </button>
          </>
        ) : (
          <div style={{ display: "flex", alignItems: "center", gap: "var(--s2)" }}>
            <span style={{ fontSize: 11, color: "var(--danger)", fontWeight: 500, whiteSpace: "nowrap" }}>Delete?</span>
            <button
              className="btn btn-sm btn-secondary"
              onClick={() => setConfirmDelete(false)}
            >
              Cancel
            </button>
            <button
              className="btn btn-sm"
              style={{ background: "var(--danger)", color: "white", border: "none", opacity: deleting ? .6 : 1 }}
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
}: {
  agents: AgentRecord[];
  onCreated: (s: ScheduleRecord) => void;
  onError: (e: string) => void;
}) {
  const [agentId, setAgentId] = useState(agents[0]?.id ?? "");
  const [kind, setKind] = useState<"cron" | "interval">("cron");
  const [spec, setSpec] = useState("0 8 * * *");
  const [label, setLabel] = useState("");
  const [saving, setSaving] = useState(false);

  function applyPreset(preset: typeof CRON_PRESETS[0]) {
    setKind(preset.kind);
    setSpec(preset.spec);
    setLabel(preset.label);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!agentId) { onError("Select an agent"); return; }
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

  return (
    <div style={{
      background: "var(--surface)", border: "1px solid var(--line)",
      borderRadius: "var(--r)", padding: "var(--s6)",
      marginBottom: "var(--s6)",
    }}>
      <h3 style={{ fontWeight: 600, fontSize: 15, marginBottom: "var(--s5)" }}>New schedule</h3>

      {/* quick presets */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--s2)", marginBottom: "var(--s5)" }}>
        <span className="micro" style={{ alignSelf: "center" }}>Quick:</span>
        {CRON_PRESETS.map(p => (
          <button
            key={p.spec}
            type="button"
            className="chip"
            onClick={() => applyPreset(p)}
            style={{
              background: spec === p.spec ? "var(--brand-tint)" : undefined,
              color: spec === p.spec ? "var(--brand)" : undefined,
              borderColor: spec === p.spec ? "var(--brand)" : undefined,
            }}
          >
            {p.label}
          </button>
        ))}
      </div>

      <form onSubmit={(e) => void handleSubmit(e)} style={{ display: "flex", flexDirection: "column", gap: "var(--s4)" }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--s4)" }}>
          <label style={{ display: "flex", flexDirection: "column", gap: "var(--s2)" }}>
            <span className="micro">Agent</span>
            <select
              className="input"
              value={agentId}
              onChange={e => setAgentId(e.target.value)}
            >
              {agents.length === 0
                ? <option value="">No agents yet</option>
                : agents.map(a => (
                    <option key={a.id} value={a.id}>{a.signed.manifest.name}</option>
                  ))}
            </select>
          </label>

          <label style={{ display: "flex", flexDirection: "column", gap: "var(--s2)" }}>
            <span className="micro">Type</span>
            <select
              className="input"
              value={kind}
              onChange={e => setKind(e.target.value as "cron" | "interval")}
            >
              <option value="cron">Cron expression</option>
              <option value="interval">Interval (ms)</option>
            </select>
          </label>
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
            {kind === "cron" && (
              <span style={{ fontSize: 11, color: "var(--ink-muted)" }}>
                min hour day month weekday
              </span>
            )}
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
          </label>
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: "var(--s3)" }}>
          <button type="submit" className="btn btn-primary" disabled={saving || agents.length === 0}>
            {saving ? "Creating…" : "Create schedule"}
          </button>
        </div>
      </form>
    </div>
  );
}

function Empty() {
  return (
    <div style={{
      padding: "var(--s9) var(--s6)",
      textAlign: "center",
      background: "var(--surface)",
      border: "1px solid var(--line)",
      borderRadius: "var(--r)",
    }}>
      <div style={{ fontSize: 32, marginBottom: "var(--s4)" }}>⏰</div>
      <div style={{ fontWeight: 600, marginBottom: "var(--s2)", fontSize: 15 }}>No schedules yet</div>
      <div style={{ fontSize: 13, color: "var(--ink-soft)", maxWidth: 400, margin: "0 auto" }}>
        Schedules make Krelvan autonomous. Create an agent, then schedule it to run every day,
        every hour, or on any cron expression you need.
      </div>
    </div>
  );
}
