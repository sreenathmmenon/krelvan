"use client";

import { useState, useEffect, use } from "react";
import Link from "next/link";
import {
  getAgent, rehearseAgent,
  type AgentRecord, type RehearsalReport, type RehearsalVerdict, type FindingLevel,
} from "../../../lib/api";

// ── Rehearsal Room ──────────────────────────────────────────────────────────────
// Cast synthetic users at an agent's REAL graph with a faked world, then read the report:
// who Krelvan sent in, what each of them got, and the handful of things to look at before the
// real world does. Nothing here is delivered, charged, or written.

const VERDICT_META: Record<RehearsalVerdict, { label: string; cls: string }> = {
  completed: { label: "Completed",        cls: "badge-done" },
  parked:    { label: "Parked · approval", cls: "badge-info" },
  looped:    { label: "Looped to cap",     cls: "badge-failed" },
  failed:    { label: "Failed",            cls: "badge-failed" },
};

function findingColor(level: FindingLevel): string {
  return level === "stop" ? "var(--danger)" : level === "warn" ? "var(--info)" : "var(--ok)";
}
function findingMark(level: FindingLevel): string {
  return level === "stop" ? "✕" : level === "warn" ? "▲" : "✓";
}

export default function RehearsePage({ params }: { params: Promise<{ agentId: string }> }) {
  const { agentId: raw } = use(params);
  const agentId = (() => { try { return decodeURIComponent(raw); } catch { return raw; } })();

  const [agent, setAgent] = useState<AgentRecord | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [report, setReport] = useState<RehearsalReport | null>(null);
  const [running, setRunning] = useState(false);
  const [runErr, setRunErr] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    getAgent(agentId)
      .then((a) => { if (live) setAgent(a); })
      .catch((e) => { if (live) setLoadErr((e as Error)?.message ?? "Couldn't load this agent."); });
    return () => { live = false; };
  }, [agentId]);

  async function run() {
    if (running) return;
    setRunning(true); setRunErr(null); setReport(null);
    try {
      const r = await rehearseAgent(agentId);
      setReport(r);
    } catch (e) {
      setRunErr((e as Error)?.message ?? "The rehearsal couldn't run.");
    } finally {
      setRunning(false);
    }
  }

  if (loadErr) {
    return (
      <main style={{ maxWidth: 860, margin: "0 auto", padding: "var(--s7) var(--s4)" }}>
        <p className="h3">Couldn&apos;t load this agent</p>
        <p className="small soft">{loadErr}</p>
        <Link href="/agents" className="btn btn-secondary btn-sm" style={{ marginTop: "var(--s3)" }}>← All agents</Link>
      </main>
    );
  }

  const name = agent?.signed.manifest.name ?? "this agent";

  return (
    <main style={{ maxWidth: 860, margin: "0 auto", padding: "var(--s6) var(--s4) var(--s8)" }}>
      {/* header */}
      <div style={{ display: "flex", alignItems: "baseline", gap: "var(--s3)", flexWrap: "wrap", marginBottom: "var(--s2)" }}>
        <span className="micro">Rehearsal Room</span>
        {agent && <Link href={`/agents/${encodeURIComponent(agentId)}`} className="small" style={{ color: "var(--brand)" }}>← {name}</Link>}
      </div>
      <h1 className="h1" style={{ margin: "0 0 var(--s3)" }}>Rehearse before you go live</h1>
      <p className="body-lg soft" style={{ maxWidth: "60ch", lineHeight: 1.6, marginBottom: "var(--s5)" }}>
        Krelvan sends a cast of synthetic users through {name}&apos;s real workflow — same steps, same
        budget, same approval gates — but the outside world is faked. Nothing is sent, charged, or written.
      </p>

      {!report && (
        <div className="card" style={{ padding: "var(--s6)", textAlign: "center" }}>
          <p className="h3" style={{ marginBottom: "var(--s2)" }}>Run a rehearsal</p>
          <p className="small soft" style={{ maxWidth: "44ch", margin: "0 auto var(--s4)", lineHeight: 1.6 }}>
            We&apos;ll cast a spread of users — the happy path, a confused newcomer, an adversarial
            edge case and more — and show you where it breaks.
          </p>
          <button className="btn btn-primary btn-lg" onClick={run} disabled={running}>
            {running ? "Rehearsing…" : "Run rehearsal"}
          </button>
          {running && <p className="small muted" style={{ marginTop: "var(--s3)" }}>Running each persona through the real graph — this can take a moment.</p>}
          {runErr && <div className="state-error" style={{ marginTop: "var(--s4)", textAlign: "left" }}>{runErr}</div>}
        </div>
      )}

      {report && <ReportView report={report} agentId={agentId} onRerun={run} rerunning={running} />}
    </main>
  );
}

function ReportView({ report, agentId, onRerun, rerunning }: { report: RehearsalReport; agentId: string; onRerun: () => void; rerunning: boolean }) {
  const { rollup } = report;
  const headlineColor = rollup.hasBlocker ? "var(--danger)" : rollup.headline ? "var(--info)" : "var(--ok)";
  const headlineText = rollup.hasBlocker
    ? "Don't ship yet — a rehearsal found a blocker."
    : rollup.headline
      ? "Worth a look before you go live."
      : "Clean rehearsal — nothing flagged.";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--s5)" }}>
      {/* roll-up banner */}
      <div className="card" style={{ padding: "var(--s5)", borderLeft: `3px solid ${headlineColor}` }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "var(--s4)", flexWrap: "wrap" }}>
          <div style={{ minWidth: 0 }}>
            <div className="h3" style={{ color: headlineColor, marginBottom: "var(--s2)" }}>{headlineText}</div>
            <div style={{ display: "flex", gap: "var(--s2)", flexWrap: "wrap" }}>
              <VCount label="Completed" n={rollup.byVerdict.completed} cls="badge-done" />
              <VCount label="Parked" n={rollup.byVerdict.parked} cls="badge-info" />
              <VCount label="Looped" n={rollup.byVerdict.looped} cls="badge-failed" />
              <VCount label="Failed" n={rollup.byVerdict.failed} cls="badge-failed" />
            </div>
            {rollup.headline && (
              <p className="small" style={{ margin: "var(--s3) 0 0", color: "var(--ink)", lineHeight: 1.5 }}>
                <b style={{ color: headlineColor }}>{findingMark(rollup.headline.level)}</b> {rollup.headline.message}
              </p>
            )}
          </div>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "var(--s2)", flexShrink: 0 }}>
            <span className="mono micro" style={{ color: "var(--ok)", display: "inline-flex", alignItems: "center", gap: "var(--s1)" }}>
              ◆ signed · not delivered anywhere
            </span>
            <span className="micro" style={{ color: "var(--ink-muted)", textTransform: "none", letterSpacing: 0 }}>
              {report.personasGenerated ? "cast by Krelvan" : "standard cast"} · {rollup.total} users
            </span>
            <button className="btn btn-secondary btn-sm" onClick={onRerun} disabled={rerunning}>
              {rerunning ? "Rehearsing…" : "Re-run"}
            </button>
          </div>
        </div>
      </div>

      {/* the cast */}
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--s3)" }}>
        {report.results.map((r, i) => {
          const meta = VERDICT_META[r.judgement.verdict];
          return (
            <div key={i} className="card" style={{ padding: "var(--s4) var(--s5)" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "var(--s3)", flexWrap: "wrap" }}>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "var(--s2)", marginBottom: "var(--s1)" }}>
                    <span className="h3" style={{ fontSize: 16 }}>{r.persona.name}</span>
                    <span className={`badge ${meta.cls}`}>{meta.label}</span>
                  </div>
                  <p className="small soft" style={{ margin: 0, lineHeight: 1.5 }}>{r.persona.description}</p>
                </div>
                {r.runId && (
                  <Link href={`/canvas/${encodeURIComponent(agentId)}?run=${encodeURIComponent(r.runId)}`}
                    className="btn btn-ghost btn-sm" style={{ flexShrink: 0 }} title="Replay this rehearsal step by step">
                    Replay →
                  </Link>
                )}
              </div>
              <ul style={{ listStyle: "none", padding: 0, margin: "var(--s3) 0 0", display: "flex", flexDirection: "column", gap: "var(--s2)" }}>
                {r.judgement.findings.map((f, j) => (
                  <li key={j} className="small" style={{ display: "flex", gap: "var(--s3)", alignItems: "flex-start", lineHeight: 1.5, color: "var(--ink)" }}>
                    <span className="mono" aria-hidden="true" style={{ color: findingColor(f.level), fontWeight: 700, flexShrink: 0, width: "1ch" }}>{findingMark(f.level)}</span>
                    <span>{f.message}</span>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function VCount({ label, n, cls }: { label: string; n: number; cls: string }) {
  if (n === 0) return null;
  return <span className={`badge ${cls}`}><b style={{ fontVariantNumeric: "tabular-nums" }}>{n}</b>&nbsp;{label}</span>;
}
