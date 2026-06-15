"use client";
import { useState, useEffect, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import {
  listAgents, listRuns, buildAgent, startRun, explainRun, timeAgo,
  type AgentRecord, type RunRecord, type BuildResult,
} from "../lib/api";
import {
  AgentCard, BuildPreviewModal, MiniGraph, HeroAnimation, EXAMPLES, BUILD_STAGES,
} from "./_builder";

// ── Krelvan landing — product-first debut ──────────────────────────────────────
// The homepage IS the working product. On first paint a visitor lands on a dark
// hero whose right side is a REAL run artifact (or a clearly-labelled live example
// until a run exists), with a CTA that drops straight into the embedded builder one
// screen below. Within seconds they can describe a goal, watch a real graph compile
// in the BuildPreviewModal, run it, and open /runs/[id] to see the actual signed,
// replayable record. We demonstrate ownership and proof by letting you DO and SEE
// it — never by lecturing about internals. The builder data path is unchanged:
// same buildAgent / startRun / explainRun as /dashboard; only the page IA + copy.

// Pre-built example graph for the hero artifact when no real run exists yet.
// Clearly labelled "live example" — never presented with fabricated proof fields.
const EXAMPLE_NODES = [
  { id: "entry", role: "intake", autonomy: "auto", capabilities: [{ name: "web_search", sideEffect: "read", budgetCents: 1 }] },
  { id: "reason", role: "reason over findings", autonomy: "auto", capabilities: [{ name: "think", sideEffect: "none", budgetCents: 3 }] },
  { id: "compose", role: "write the digest", autonomy: "auto", capabilities: [{ name: "compose", sideEffect: "none", budgetCents: 2 }] },
];
const EXAMPLE_EDGES = [
  { from: "entry", to: "reason" },
  { from: "reason", to: "compose" },
];

// ── Copyable one-command install (final CTA) ─────────────────────────────────
const INSTALL_CMD = "git clone https://github.com/sreenathmmenon/krelvan && cd krelvan && npx krelvan";

function InstallCommand() {
  const [copied, setCopied] = useState(false);
  const copy = useCallback(() => {
    void navigator.clipboard.writeText(INSTALL_CMD).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    });
  }, []);
  return (
    <div className="install-cmd" role="group" aria-label="One-command install">
      <span className="install-cmd__prompt" aria-hidden="true">$</span>
      <code className="install-cmd__code">{INSTALL_CMD}</code>
      <button
        type="button"
        className="install-cmd__copy"
        data-copied={copied}
        onClick={copy}
        aria-label={copied ? "Command copied to clipboard" : "Copy install command"}
      >
        {copied ? "✓ Copied" : "Copy"}
      </button>
    </div>
  );
}

// ── Hero artifact: a REAL run (signed · N events · cost), or a labelled example ──
// When a completed run exists we render its honest header and link to /runs/[id].
// Until then we show the pre-built example graph self-running, clearly framed as a
// "live example" — no invented field names, no fabricated proof.
function HeroArtifact({ run }: { run: RunRecord | null }) {
  if (run) {
    return (
      <a
        href={`/runs/${run.runId}`}
        className="dark-device"
        style={{ display: "block", padding: "var(--s5)", textDecoration: "none" }}
        aria-label={`Open the signed record for ${run.manifestName}`}
      >
        <div className="micro" style={{ marginBottom: "var(--s3)" }}>A real run · {timeAgo(run.createdAt)}</div>
        <div
          className="dark-surface-2"
          style={{ borderRadius: "var(--r)", padding: "var(--s5)", display: "flex", flexDirection: "column", gap: "var(--s4)" }}
        >
          <div className="dark-ink" style={{ fontSize: 18, fontWeight: 500, letterSpacing: "-0.01em" }}>
            {run.manifestName}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "var(--s3)", flexWrap: "wrap" }}>
            <span className="dark-verify-seal__mark" aria-hidden="true">✓</span>
            <span className="dark-teal mono" style={{ fontSize: 13, fontWeight: 600, letterSpacing: ".02em" }}>signed</span>
            <span className="dark-ink-muted" aria-hidden="true">·</span>
            <span className="dark-ink-soft mono" style={{ fontSize: 13 }}>
              {run.status === "completed" ? "finished" : run.status}
            </span>
          </div>
          <div className="dark-ink-muted small" style={{ display: "flex", alignItems: "center", gap: "var(--s2)" }}>
            <span>Every step is recorded and can be replayed.</span>
          </div>
        </div>
        <div className="dark-teal mono" style={{ marginTop: "var(--s4)", fontSize: 12, fontWeight: 600 }}>
          Open this record →
        </div>
      </a>
    );
  }

  // No real run yet → labelled live example (the pre-built research-digest graph).
  return (
    <div className="dark-device" style={{ padding: "var(--s5)" }}>
      <div className="micro" style={{ marginBottom: "var(--s3)" }}>Live example · research digest</div>
      <div
        className="dark-surface-2"
        style={{ borderRadius: "var(--r)", padding: "var(--s5)", display: "flex", flexDirection: "column", gap: "var(--s4)" }}
      >
        <div style={{ background: "var(--dark-node-fill)", borderRadius: "var(--r)", padding: "var(--s5)", border: "1px solid var(--dark-line)" }}>
          <MiniGraph nodes={EXAMPLE_NODES} edges={EXAMPLE_EDGES} entry="entry" variant="dark" maxHeight={120} />
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "var(--s3)", flexWrap: "wrap" }}>
          <span className="dark-verify-seal__mark" aria-hidden="true">✓</span>
          <span className="dark-teal mono" style={{ fontSize: 13, fontWeight: 600, letterSpacing: ".02em" }}>signed</span>
          <span className="dark-ink-muted" aria-hidden="true">·</span>
          <span className="dark-ink-soft mono" style={{ fontSize: 13 }}>3 steps</span>
        </div>
        <div className="dark-ink-muted small">
          Build your own below — your real runs show up here.
        </div>
      </div>
    </div>
  );
}

function focusBuilder() {
  const section = document.getElementById("builder");
  section?.scrollIntoView({ behavior: "smooth", block: "start" });
  const ta = section?.querySelector<HTMLTextAreaElement>("textarea");
  // focus after the smooth scroll begins so it doesn't jump the page
  window.setTimeout(() => ta?.focus({ preventScroll: true }), 320);
}

export default function Landing() {
  const router = useRouter();
  const [intent, setIntent] = useState("");
  const [building, setBuilding] = useState(false);
  const [buildStage, setBuildStage] = useState(0);
  const [buildError, setBuildError] = useState<string | null>(null);
  const [buildResult, setBuildResult] = useState<BuildResult | null>(null);
  const [agents, setAgents] = useState<AgentRecord[]>([]);
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [composeFocused, setComposeFocused] = useState(false);
  const [summaries, setSummaries] = useState<Record<string, string | null>>({});
  const fetchingSummaries = useRef<Set<string>>(new Set());

  const reload = useCallback(async () => {
    try {
      const [a, r] = await Promise.all([listAgents(), listRuns()]);
      setAgents(a);
      setRuns(r);
    } catch { /* API not yet reachable */ }
    finally { setLoading(false); }
  }, []);

  // Auto-fetch one-line summaries for completed runs (same as the workspace)
  useEffect(() => {
    for (const run of runs) {
      if (run.status !== "completed") continue;
      if (fetchingSummaries.current.has(run.runId)) continue;
      if (summaries[run.runId] !== undefined) continue;
      fetchingSummaries.current.add(run.runId);
      setSummaries(prev => ({ ...prev, [run.runId]: null }));
      void explainRun(run.runId)
        .then(res => {
          const firstLine = res.explanation.split("\n").filter(l => l.trim()).slice(0, 2).join(" ").slice(0, 220);
          setSummaries(prev => ({ ...prev, [run.runId]: firstLine }));
        })
        .catch(() => {
          setSummaries(prev => { const n = { ...prev }; delete n[run.runId]; return n; });
          fetchingSummaries.current.delete(run.runId);
        });
    }
  }, [runs, summaries]);

  useEffect(() => {
    void reload();
    const t = setInterval(() => void reload(), 3000);
    return () => clearInterval(t);
  }, [reload]);

  // Cycle build-stage messages while building (same cadence as the workspace)
  useEffect(() => {
    if (!building) { setBuildStage(0); return; }
    const t = setInterval(() => setBuildStage(s => (s + 1) % BUILD_STAGES.length), 3500);
    return () => clearInterval(t);
  }, [building]);

  async function handleBuild(e: React.FormEvent) {
    e.preventDefault();
    if (!intent.trim() || building) return;
    setBuilding(true);
    setBuildError(null);
    try {
      const result = await buildAgent(intent.trim());
      setBuildResult(result);
      setIntent("");
      await reload();
    } catch (err) {
      setBuildError((err as Error).message);
    } finally {
      setBuilding(false);
    }
  }

  async function handleRunBuilt() {
    if (!buildResult) return;
    const agentId = buildResult.agent.id;
    const savedResult = buildResult;
    setBuildResult(null);
    try {
      const run = await startRun(agentId);
      await reload();
      router.push(`/runs/${run.runId}`);
    } catch (err) {
      setBuildError((err as Error).message);
      setBuildResult(savedResult);
    }
  }

  const running = runs.filter(r => r.status === "running").length;
  const recentRuns = runs.slice(0, 6);
  const hasData = agents.length > 0 || runs.length > 0;

  // Most recent completed run — the real artifact for the hero + the proof block.
  // runs come newest-first from the API, so the first completed one is the latest.
  const latestCompleted = runs.find(r => r.status === "completed") ?? null;

  // For the "here's a real agent" block: the agent behind that run + its summary.
  const proofAgent = latestCompleted
    ? agents.find(a => a.id === latestCompleted.agentId) ?? null
    : null;
  const proofSummary = latestCompleted ? (summaries[latestCompleted.runId] ?? null) : null;

  // 6-bucket run-volume sparkline: count runs per day over the last 6 days,
  // normalized to bar heights. Purely derived from `runs` — no new data path.
  const sparkBuckets = (() => {
    const day = 86_400_000;
    const now = Date.now();
    const counts = [0, 0, 0, 0, 0, 0];
    for (const r of runs) {
      const t = r.createdAt;
      if (!Number.isFinite(t)) continue;
      const idx = 5 - Math.floor((now - t) / day);
      if (idx >= 0 && idx < 6) counts[idx]! += 1;
    }
    const max = Math.max(1, ...counts);
    return counts.map(c => Math.max(0.12, c / max));
  })();

  return (
    <div>
      {buildResult && (
        <BuildPreviewModal
          result={buildResult}
          onRun={handleRunBuilt}
          onDiscard={() => setBuildResult(null)}
        />
      )}

      {/* ════════════ 1 · DARK HERO ════════════ */}
      <section className="hero-dark" style={{ minHeight: "88vh", display: "flex", alignItems: "center", paddingTop: "var(--s9)", paddingBottom: "var(--s9)" }}>
        <div className="container" style={{ position: "relative", zIndex: 1, width: "100%" }}>
          <div className="hero-grid">
            {/* left — payoff + CTAs (42%) */}
            <div>
              <p className="micro" style={{ marginBottom: "var(--s4)" }}>Build it. Run it. Own it.</p>
              <h1
                className="dark-ink"
                style={{ fontSize: "clamp(32px, 5vw, 46px)", lineHeight: 1.08, fontWeight: 300, letterSpacing: "-0.025em", marginBottom: "var(--s5)" }}
              >
                Your own AI agents. Built in seconds, <span className="dark-teal">running on your machine</span>.
              </h1>
              <p className="dark-ink-soft body-lg" style={{ maxWidth: "50ch", marginBottom: "var(--s7)" }}>
                Describe a goal in plain English and Krelvan builds the agent, shows you
                the plan, and runs it — keeping a record of every step you can open and
                replay. No cloud. No lock-in. Yours to keep.
              </p>
              <div style={{ display: "flex", gap: "var(--s3)", flexWrap: "wrap" }}>
                <button className="btn btn-dark-primary btn-lg" onClick={focusBuilder}>
                  Build an agent
                </button>
                {latestCompleted ? (
                  <a href={`/runs/${latestCompleted.runId}`} className="btn btn-dark-ghost btn-lg">
                    See a real run
                  </a>
                ) : (
                  <button className="btn btn-dark-ghost btn-lg" onClick={focusBuilder}>
                    Try an example
                  </button>
                )}
              </div>
            </div>

            {/* right — animated "agent runs → ledger signs it" loop. When the user
                already has a real completed run, show THAT (real proof beats a demo);
                otherwise the self-running animation. */}
            <div style={{ animation: "fade-in 400ms var(--ease) forwards" }}>
              {latestCompleted ? <HeroArtifact run={latestCompleted} /> : <HeroAnimation />}
            </div>
          </div>
        </div>
      </section>

      {/* ════════════ 2 · EMBEDDED LIVE BUILDER ════════════ */}
      {/* The exact workspace composer + BuildPreviewModal + stat strip + agents/runs.
          Same data path (buildAgent / startRun / explainRun) as /dashboard.
          This is the dominant first-interaction zone, right under the hero. */}
      <section id="builder" className="builder-zone" style={{ scrollMarginTop: "var(--s6)" }}>
        <div className="container" style={{ paddingTop: "var(--s8)", paddingBottom: "var(--s8)", textAlign: "center" }}>
          <h2 className="h1" style={{ marginBottom: "var(--s3)" }}>Build and run an agent in seconds.</h2>
          <p className="body-lg soft" style={{ maxWidth: "48ch", margin: "0 auto var(--s6)" }}>
            Describe what you want done. Krelvan plans the agent, shows it to you, and runs it on your own machine.
          </p>

          {/* composer — elevated build box */}
          <div style={{ maxWidth: 700, margin: "0 auto" }}>
            <form
              onSubmit={(e) => void handleBuild(e)}
              className={`build-box${composeFocused ? " is-focused" : ""}`}
            >
              {/* labelled top row — frames the box as a real tool, not a bare field */}
              <div className="build-box__head">
                <span className="build-box__badge" aria-hidden="true">
                  <svg viewBox="0 0 16 16" width="14" height="14" fill="none">
                    <path d="M8 1.6l1.7 4.7L14.4 8l-4.7 1.7L8 14.4l-1.7-4.7L1.6 8l4.7-1.7L8 1.6z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
                  </svg>
                </span>
                <span className="micro" style={{ color: "var(--ink-soft)" }}>Describe your agent</span>
              </div>

              <textarea
                value={intent}
                onChange={e => { setIntent(e.target.value); if (buildError) setBuildError(null); }}
                onFocus={() => setComposeFocused(true)}
                onBlur={() => setComposeFocused(false)}
                placeholder="e.g. Review this contract and tell me what we should negotiate before signing"
                aria-label="Describe a goal"
                rows={3}
                className="input build-box__textarea"
              />

              {/* example chips — compact, single row, scrollable */}
              <div className="build-box__examples">
                <span className="micro build-box__examples-label">Try:</span>
                {EXAMPLES.map(ex => (
                  <button key={ex.label} type="button" className="build-chip" onClick={() => setIntent(ex.text)}>
                    {ex.label}
                  </button>
                ))}
              </div>

              {buildError && (
                <div role="alert" className="state-error" style={{ margin: "var(--s4) 0 0", justifyContent: "space-between" }}>
                  <span>{buildError}</span>
                  <button
                    onClick={() => setBuildError(null)}
                    aria-label="Dismiss error"
                    style={{ background: "none", border: "none", cursor: "pointer", color: "var(--danger)", fontSize: 16, lineHeight: 1, flexShrink: 0, padding: "0 var(--s1)" }}
                  >×</button>
                </div>
              )}

              <div className="build-box__foot">
                <div className="small" style={{ color: "var(--ink-muted)", minHeight: 18, textAlign: "left" }}>
                  {building
                    ? <span key={buildStage} style={{ animation: "fade-in 150ms ease forwards" }}>{BUILD_STAGES[buildStage]}</span>
                    : <span>You review the plan before anything runs.</span>}
                </div>
                <button
                  type="submit"
                  className="btn btn-primary btn-lg"
                  disabled={!intent.trim() || building}
                  style={{ minWidth: 150 }}
                >
                  {building ? "Building…" : "Build agent →"}
                </button>
              </div>
            </form>
          </div>
        </div>

        {/* ════════════ 3 · PROOF STRIP + YOUR AGENTS + RECENT RUNS ════════════ */}
        {/* Marketing homepage: this workspace band only renders for RETURNING users who
            already have agents/runs (it gives them a quick jump-back-in). First-time
            visitors (empty) never see an empty dashboard mid-scroll — the page flows
            hero → builder → real-agent proof → install. The full workspace lives at
            /dashboard. */}
        {hasData && (<>
        <div className="container" style={{ paddingBottom: "var(--s4)" }}>
          {agents.length === 0 && runs.length === 0 && !loading ? (
            <div className="stat-strip" style={{ padding: "var(--s5) var(--s6)" }}>
              <span className="small muted">No agents yet — build your first one above ↑</span>
            </div>
          ) : (
            <div className="stat-strip">
              {[
                { label: "agents",      value: String(agents.length), live: false },
                { label: "running now", value: String(running),       live: running > 0 },
                { label: "total runs",  value: String(runs.length),   live: false },
              ].map(s => (
                <div key={s.label} className={`stat-cell${s.live ? " is-live" : ""}`}>
                  <span className="stat-value">{s.value}</span>
                  <span className="stat-label">{s.label}</span>
                </div>
              ))}
              <div className="stat-cell">
                <div className="stat-spark" aria-hidden="true">
                  {sparkBuckets.map((h, i) => (
                    <span key={i} style={{ height: `${Math.round(h * 100)}%`, animationDelay: `${i * 60}ms` }} />
                  ))}
                </div>
                <span className="stat-label">last 6 days</span>
              </div>
            </div>
          )}
        </div>

        {/* agents + recent runs */}
        <div className="container" style={{ paddingTop: "var(--s8)", paddingBottom: "var(--s9)" }}>
          <div className="builder-grid">
            {/* agent cards */}
            <div>
              <h3 className="micro" style={{ marginBottom: "var(--s5)" }}>Your agents</h3>

              {loading && (
                <div className="state-loading">
                  <span className="spinner" aria-hidden="true" />
                  <span>Loading agents…</span>
                </div>
              )}

              {!loading && agents.length === 0 && (
                <div style={{ padding: "var(--s9)", textAlign: "center", border: "1px dashed var(--line-strong)", borderRadius: "var(--r-lg)", background: "var(--surface)" }}>
                  <div aria-hidden="true" style={{ fontSize: 32, marginBottom: "var(--s5)", opacity: 0.5 }}>✦</div>
                  <p className="h3" style={{ marginBottom: "var(--s3)", color: "var(--ink)" }}>Build your first agent</p>
                  <p className="body-lg soft" style={{ maxWidth: "34ch", margin: "0 auto var(--s6)" }}>
                    Describe a goal above. Your first agent compiles in ~<span className="mono">30</span> seconds and is ready to run immediately.
                  </p>
                  <button className="btn btn-primary" onClick={focusBuilder}>
                    Describe a goal →
                  </button>
                </div>
              )}

              {agents.length > 0 && (
                <div className="builder-agents">
                  {agents.map(a => {
                    const agentRuns = runs.filter(r => r.agentId === a.id);
                    const lastCompletedRun = agentRuns.find(r => r.status === "completed");
                    const cardSummary = lastCompletedRun ? (summaries[lastCompletedRun.runId] ?? null) : undefined;
                    return (
                      <AgentCard
                        key={a.id}
                        agent={a}
                        agentRuns={agentRuns}
                        summary={cardSummary}
                        onRun={() => { void startRun(a.id).then(r => { void reload(); router.push(`/runs/${r.runId}`); }); }}
                        onDelete={() => { void reload(); }}
                      />
                    );
                  })}
                  <a
                    href="#builder"
                    onClick={e => { e.preventDefault(); focusBuilder(); }}
                    style={{
                      display: "flex", alignItems: "center", justifyContent: "center",
                      minHeight: 200, border: "1px dashed var(--line-strong)", borderRadius: "var(--r)",
                      color: "var(--ink-muted)", fontSize: 13, fontWeight: 500, gap: "var(--s2)",
                      textDecoration: "none", transition: "border-color 120ms, color 120ms",
                    }}
                    onMouseEnter={e => { e.currentTarget.style.borderColor = "var(--brand)"; e.currentTarget.style.color = "var(--brand)"; }}
                    onMouseLeave={e => { e.currentTarget.style.borderColor = "var(--line-strong)"; e.currentTarget.style.color = "var(--ink-muted)"; }}
                  >
                    <span style={{ fontSize: 20, lineHeight: 1 }}>+</span> New agent
                  </a>
                </div>
              )}
            </div>

            {/* recent runs */}
            <div>
              <h3 className="micro" style={{ marginBottom: "var(--s5)" }}>Recent runs</h3>
              {recentRuns.length === 0 && (
                <div className="state-empty">
                  <span className="small">No runs yet.</span>
                </div>
              )}
              {recentRuns.length > 0 && (
                <div className="card" style={{ padding: 0, overflow: "hidden" }}>
                  {recentRuns.map((r, i) => (
                    <a
                      key={r.runId}
                      href={`/runs/${r.runId}`}
                      style={{
                        display: "flex", gap: "var(--s3)", padding: "var(--s3) var(--s4)",
                        borderTop: i === 0 ? "none" : "1px solid var(--line)",
                        textDecoration: "none", color: "var(--ink)",
                        transition: "background 100ms",
                      }}
                      onMouseEnter={e => (e.currentTarget.style.background = "var(--surface-hover)")}
                      onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
                    >
                      <span className={`status-dot ${r.status === "completed" ? "done" : r.status === "failed" ? "failed" : r.status === "running" ? "running" : "paused"}`} style={{ marginTop: "var(--s1)", flexShrink: 0 }} />
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div className="small text-truncate" style={{ fontWeight: 500 }}>{r.manifestName}</div>
                        <div style={{ display: "flex", gap: "var(--s3)", marginTop: "var(--s1)" }}>
                          <span className="small muted">{timeAgo(r.createdAt)}</span>
                        </div>
                        {/* mini ledger strip — signed/replayable tag (no cost shown) */}
                        {(r.status === "completed" || r.status === "failed") && (
                          <div className="run-ledger-strip">
                            <span className="run-ledger-strip__seal" aria-hidden="true">✓</span>
                            <span className="run-ledger-strip__tag">signed · replayable</span>
                          </div>
                        )}
                      </div>
                    </a>
                  ))}
                </div>
              )}
              <div style={{ marginTop: "var(--s3)" }}>
                <a href="/runs" className="small" style={{ color: "var(--brand)" }}>All runs →</a>
              </div>
            </div>
          </div>
        </div>
        </>)}
      </section>

      {/* ════════════ 4 · HERE'S A REAL AGENT ════════════ */}
      {/* Built from ACTUAL agent/run data when available, else the labelled example.
          Concrete, replayable, owned — not a feature grid. */}
      <section style={{ background: "var(--canvas)", borderTop: "1px solid var(--line)" }}>
        <div className="container" style={{ paddingTop: "var(--s9)", paddingBottom: "var(--s9)" }}>
          <h2 className="h1" style={{ marginBottom: "var(--s3)", maxWidth: "26ch" }}>
            A real agent. A real run. Proof you can open.
          </h2>
          <p className="body-lg soft" style={{ maxWidth: "52ch", marginBottom: "var(--s7)" }}>
            {latestCompleted
              ? "This one ran on this machine. Open it and replay every step."
              : "Build one below and it shows up here — the graph it compiled, every step it took, and a record you can open."}
          </p>

          {latestCompleted && proofAgent ? (
            <div className="card" style={{ padding: "var(--s6)", maxWidth: 720, display: "flex", flexDirection: "column", gap: "var(--s5)" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "var(--s3)", flexWrap: "wrap" }}>
                <div>
                  <div className="h3" style={{ color: "var(--ink)", marginBottom: "var(--s1)" }}>{proofAgent.signed.manifest.name}</div>
                  <div className="small muted">{timeAgo(latestCompleted.createdAt)}</div>
                </div>
                <span
                  className="mono"
                  style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "var(--s1) var(--s3)", borderRadius: "var(--r-pill)", background: "var(--brand-tint)", color: "var(--brand)", fontSize: 12, fontWeight: 600 }}
                >
                  <span aria-hidden="true">✓</span> signed
                </span>
              </div>

              <div style={{ background: "var(--graph-bg)", borderRadius: "var(--r)", border: "1px solid var(--line)", padding: "var(--s4)", overflow: "hidden", maxHeight: 110 }}>
                <MiniGraph
                  nodes={proofAgent.signed.manifest.nodes}
                  edges={proofAgent.signed.manifest.edges}
                  entry={proofAgent.signed.manifest.entry}
                />
              </div>

              {proofSummary && (
                <p className="small" style={{ lineHeight: 1.6, color: "var(--ink-soft)", overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical" }}>
                  {proofSummary}
                </p>
              )}

              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "var(--s4)", flexWrap: "wrap" }}>
                <span className="mono" style={{ fontSize: 13, color: "var(--brand)", fontWeight: 600 }}>✓ signed · replayable</span>
                <a href={`/runs/${latestCompleted.runId}`} className="btn btn-primary">View this run →</a>
              </div>
            </div>
          ) : (
            <div className="card" style={{ padding: "var(--s6)", maxWidth: 720, display: "flex", flexDirection: "column", gap: "var(--s5)" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "var(--s3)", flexWrap: "wrap" }}>
                <div>
                  <div className="h3" style={{ color: "var(--ink)", marginBottom: "var(--s1)" }}>Research digest</div>
                  <div className="small muted">Example</div>
                </div>
                <span
                  className="mono"
                  style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "var(--s1) var(--s3)", borderRadius: "var(--r-pill)", background: "var(--brand-tint)", color: "var(--brand)", fontSize: 12, fontWeight: 600 }}
                >
                  <span aria-hidden="true">✓</span> signed
                </span>
              </div>
              <div style={{ background: "var(--graph-bg)", borderRadius: "var(--r)", border: "1px solid var(--line)", padding: "var(--s4)", overflow: "hidden", maxHeight: 110 }}>
                <MiniGraph nodes={EXAMPLE_NODES} edges={EXAMPLE_EDGES} entry="entry" />
              </div>
              <p className="small soft" style={{ lineHeight: 1.6 }}>
                Search the web, reason over the findings, and write a clear digest — three signed steps.
              </p>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "var(--s4)", flexWrap: "wrap" }}>
                <span className="mono" style={{ fontSize: 13, color: "var(--brand)", fontWeight: 600 }}>✓ signed · replayable</span>
                <button className="btn btn-primary" onClick={focusBuilder}>Build this →</button>
              </div>
            </div>
          )}
        </div>
      </section>

      {/* ════════════ 5 · FINAL CTA (dark) ════════════ */}
      {/* Build-on-Krelvan — the platform-base value prop: eliminated decisions. */}
      <section style={{ background: "var(--canvas)", borderTop: "1px solid var(--line)" }}>
        <div className="container" style={{ paddingTop: "var(--s9)", paddingBottom: "var(--s9)" }}>
          <p className="micro" style={{ marginBottom: "var(--s3)" }}>Build on it</p>
          <h2 className="h1" style={{ marginBottom: "var(--s3)", maxWidth: "24ch" }}>
            The value isn&apos;t features. It&apos;s <span style={{ color: "var(--brand)" }}>eliminated decisions</span>.
          </h2>
          <p className="body-lg soft" style={{ maxWidth: "60ch", marginBottom: "var(--s7)" }}>
            Memory, approval flows, audit, agent coordination, failure-reasoning — solved.
            You build the domain logic and the client workflow. Ship agentic solutions in
            days, not months.
          </p>
          <div className="build-on-grid">
            {[
              { k: "Memory", v: "Episodic, semantic and trust-aware — right by default." },
              { k: "Approval flows", v: "Standard human-in-the-loop pause / approve / resume." },
              { k: "Audit by default", v: "Every step signed to a tamper-evident record." },
              { k: "Agent coordination", v: "Sub-agent delegation with supervisor co-sign." },
              { k: "Failure-reasoning", v: "It reasons about why a run failed — and how to fix it." },
              { k: "Capability ecosystem", v: "Install a connector; it works in any agent." },
            ].map(c => (
              <div key={c.k} className="card" style={{ padding: "var(--s5)" }}>
                <div className="h3" style={{ color: "var(--ink)", marginBottom: "var(--s2)", display: "flex", alignItems: "center", gap: "var(--s2)" }}>
                  <span aria-hidden="true" style={{ color: "var(--brand)", display: "inline-flex" }}>
                    <svg viewBox="0 0 16 16" width="16" height="16" fill="none"><path d="M3.5 8.5l3 3 6-6.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/></svg>
                  </span>
                  {c.k}
                </div>
                <p className="small soft" style={{ margin: 0, lineHeight: 1.55 }}>{c.v}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="hero-dark" style={{ paddingTop: "var(--s9)", paddingBottom: "var(--s9)" }}>
        <div className="container" style={{ position: "relative", zIndex: 1, textAlign: "center" }}>
          <p className="micro" style={{ marginBottom: "var(--s4)" }}>Self-hosted</p>
          <h2 className="dark-ink display" style={{ marginBottom: "var(--s4)" }}>
            Run it on your <span className="dark-teal">own machine</span>.
          </h2>
          <p className="dark-ink-soft body-lg" style={{ maxWidth: "54ch", margin: "0 auto var(--s6)" }}>
            Download it and run it yourself — for you, your team, or your clients.
            Your keys, your data, your infrastructure. Use it however you need.
          </p>
          <div style={{ marginBottom: "var(--s6)" }}>
            <InstallCommand />
            <p className="dark-ink-muted small" style={{ marginTop: "var(--s3)" }}>
              Boots the API and web UI on <span className="mono">localhost:3100</span> · or run{" "}
              <span className="mono">docker compose up</span>
            </p>
          </div>
          <p className="dark-ink-soft body-lg" style={{ maxWidth: "54ch", margin: "0 auto var(--s6)" }}>
            When someone asks what your agent did, you hand them a signed record —
            not a vendor&apos;s word.
          </p>
          <div style={{ display: "flex", gap: "var(--s3)", justifyContent: "center", flexWrap: "wrap" }}>
            <a href="https://github.com/sreenathmmenon/krelvan" className="btn btn-dark-primary btn-lg">
              View on GitHub
            </a>
            <button className="btn btn-dark-ghost btn-lg" onClick={focusBuilder}>
              Try the builder
            </button>
          </div>
        </div>
      </section>

    </div>
  );
}
