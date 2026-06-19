"use client";
import { useState, useEffect, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  listAgents, listRuns, buildAgent, startRun, autoSummarizeRuns, timeAgo, getCached,
  type AgentRecord, type RunRecord, type BuildResult,
} from "../../lib/api";
import {
  AgentCard, BuildPreviewModal, MiniGraph, HeroArtifact, HeroAnimation, EXAMPLES, BUILD_STAGES,
} from "../_builder";

// ── Dashboard (the workspace) ───────────────────────────────────────────────────
// The signed-in workspace. Two deliberate shapes:
//
//   EMPTY (launch day — every first visitor): a confident, single-path hero. One
//   teal intro frames an ELEVATED composer (the one and only CTA), and a "what you
//   can build" gallery of one-click EXAMPLES with live mini-graphs makes the page
//   feel full and purposeful with zero data — no dashed boxes, no triple-empty.
//
//   POPULATED (agents or runs exist): a compact composer up top, the live stat
//   strip (with a run-volume sparkline + amber pulse when something runs), the
//   "Your agents" grid and a "Recent runs" sidebar.
//
// Same data path as the homepage builder (buildAgent / startRun / explainRun) —
// this pass is visual / IA only.

// Pre-built example graphs for the empty-state gallery. Each maps 1:1 to one of the
// shared EXAMPLES so a one-click card shows BOTH the goal and the shape it compiles
// to. Purely illustrative (clearly framed as "examples") — no fabricated proof.
const GALLERY: { ex: typeof EXAMPLES[number]; nodes: { id: string; role: string; autonomy: string; capabilities: { name: string; sideEffect: string; budgetCents: number }[] }[]; edges: { from: string; to: string }[]; entry: string }[] = [
  {
    ex: EXAMPLES[0]!,
    nodes: [
      { id: "search", role: "search the web", autonomy: "auto", capabilities: [{ name: "web_search", sideEffect: "read", budgetCents: 1 }] },
      { id: "reason", role: "reason over findings", autonomy: "auto", capabilities: [{ name: "think", sideEffect: "none", budgetCents: 3 }] },
      { id: "digest", role: "write the digest", autonomy: "auto", capabilities: [{ name: "compose", sideEffect: "none", budgetCents: 2 }] },
    ],
    edges: [{ from: "search", to: "reason" }, { from: "reason", to: "digest" }],
    entry: "search",
  },
  {
    ex: EXAMPLES[1]!,
    nodes: [
      { id: "fetch", role: "fetch the release feed", autonomy: "auto", capabilities: [{ name: "http_get", sideEffect: "read", budgetCents: 1 }] },
      { id: "summary", role: "summarise the changes", autonomy: "auto", capabilities: [{ name: "compose", sideEffect: "none", budgetCents: 2 }] },
    ],
    edges: [{ from: "fetch", to: "summary" }],
    entry: "fetch",
  },
  {
    ex: EXAMPLES[2]!,
    nodes: [
      { id: "research", role: "research use cases", autonomy: "auto", capabilities: [{ name: "web_search", sideEffect: "read", budgetCents: 2 }] },
      { id: "rank", role: "rank by impact", autonomy: "auto", capabilities: [{ name: "think", sideEffect: "none", budgetCents: 3 }] },
      { id: "report", role: "write the ranked report", autonomy: "auto", capabilities: [{ name: "compose", sideEffect: "none", budgetCents: 2 }] },
    ],
    edges: [{ from: "research", to: "rank" }, { from: "rank", to: "report" }],
    entry: "research",
  },
];

function focusComposer() {
  const ta = document.querySelector<HTMLTextAreaElement>("#dashboard-composer textarea");
  ta?.scrollIntoView({ behavior: "smooth", block: "center" });
  window.setTimeout(() => ta?.focus({ preventScroll: true }), 320);
}

// ── Teal geometric SVG glyphs (no emoji anywhere) ────────────────────────────
function SparkGlyph({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M8 1.5l1.6 4.9L14.5 8l-4.9 1.6L8 14.5l-1.6-4.9L1.5 8l4.9-1.6L8 1.5z"
        stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
    </svg>
  );
}
function ClockGlyph({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="5.6" stroke="currentColor" strokeWidth="1.3" />
      <path d="M8 4.6V8l2.4 1.6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function SealGlyph({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="5.6" stroke="currentColor" strokeWidth="1.3" />
      <path d="M5.4 8.1l1.8 1.8 3.4-3.6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export default function Dashboard() {
  const router = useRouter();
  const [intent, setIntent] = useState("");
  const [building, setBuilding] = useState(false);
  const [buildStage, setBuildStage] = useState(0);
  const [buildError, setBuildError] = useState<string | null>(null);
  const [buildResult, setBuildResult] = useState<BuildResult | null>(null);
  const cachedAgents = getCached<AgentRecord[]>("agents");
  const [agents, setAgents] = useState<AgentRecord[]>(cachedAgents ?? []);
  const [runs, setRuns] = useState<RunRecord[]>(getCached<RunRecord[]>("runs") ?? []);
  const [loading, setLoading] = useState(!cachedAgents);
  const [composeFocused, setComposeFocused] = useState(false);
  // runId → summary text (null = generating, string = done, key absent = not started)
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

  // Background summaries — BOUNDED (most recent few, low concurrency) so we never fire one
  // LLM call per run on load and flood the single-process API.
  useEffect(() => {
    const pending = runs
      .filter(r => r.status === "completed" && summaries[r.runId] === undefined && !fetchingSummaries.current.has(r.runId))
      .map(r => r.runId);
    if (pending.length === 0) return;
    pending.forEach(id => fetchingSummaries.current.add(id));
    return autoSummarizeRuns(pending, (runId, summary) => {
      setSummaries(prev => ({ ...prev, [runId]: summary }));
    });
  }, [runs, summaries]);

  useEffect(() => {
    void reload();
    const t = setInterval(() => void reload(), 3000);
    return () => clearInterval(t);
  }, [reload]);

  // Cycle build stage messages while building
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
      // Go straight to the run's Output tab — shows results as they arrive
      router.push(`/runs/${run.runId}`);
    } catch (err) {
      setBuildError((err as Error).message);
      setBuildResult(savedResult);
    }
  }

  function pickExample(text: string) {
    setIntent(text);
    if (buildError) setBuildError(null);
    focusComposer();
  }

  const running = runs.filter(r => r.status === "running").length;
  const recentRuns = runs.slice(0, 6);
  const hasData = agents.length > 0 || runs.length > 0;
  const latestCompleted = runs.find(r => r.status === "completed") ?? null;
  // empty = launch-day shape. We only commit to it once the first load resolves so
  // we never flash the hero before real data arrives.
  const isEmpty = !loading && !hasData;

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

  // ── shared composer markup — the SAME build-box used on the homepage, for a
  // consistent build experience across both surfaces. ─────────────────────────
  const composerInner = (
    <form onSubmit={(e) => void handleBuild(e)} className={`build-box${composeFocused ? " is-focused" : ""}`}>
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
        placeholder="e.g. Search the web for the latest AI news and summarise the top developments in a clear digest"
        aria-label="Describe a goal"
        rows={isEmpty ? 3 : 2}
        className="input build-box__textarea"
      />

      <div className="build-box__examples">
        <span className="micro build-box__examples-label">Try:</span>
        {EXAMPLES.map(ex => (
          <button key={ex.label} type="button" className="build-chip" onClick={() => setIntent(ex.text)}>
            {ex.label}
          </button>
        ))}
      </div>

      {buildError && (
        <div role="alert" className="state-error" style={{ margin: "0 var(--s5) var(--s4)", justifyContent: "space-between" }}>
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
  );

  return (
    <div style={{ minHeight: "100vh" }}>

      {buildResult && (
        <BuildPreviewModal
          result={buildResult}
          onRun={handleRunBuilt}
          onDiscard={() => setBuildResult(null)}
        />
      )}

      {/* ── page header (populated / loading only — hidden on empty so the empty
          state opens with the dark hero + composer as the very first element) ── */}
      {!isEmpty && (
        <div style={{ background: "var(--surface)", borderBottom: "1px solid var(--line)" }}>
          <div className="container" style={{ paddingTop: "var(--s8)", paddingBottom: "var(--s6)" }}>
            <div className="workspace-head">
              <div>
                <p className="micro" style={{ marginBottom: "var(--s3)" }}>Workspace</p>
                <h1 className="h1" style={{ color: "var(--ink)", marginBottom: "var(--s2)" }}>
                  Your AI agent workspace
                </h1>
                <p className="body-lg soft" style={{ maxWidth: "56ch" }}>
                  Describe a goal, review the plan, then run it. Every step is recorded to a record you own and can replay.
                </p>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ════════════════════════════════════════════════════════════════════════
          EMPTY STATE — the launch-day first impression. A DARK hero (matching the
          homepage's --dark-bg) makes the composer the page's single center of
          gravity: one payoff line, the elevated composer (the only CTA), nothing
          competing. The "what you can build" gallery lives well below in light. */}
      {isEmpty && (
        <>
          <section
            className="hero-dark"
            style={{ minHeight: "80vh", display: "flex", alignItems: "center", paddingTop: "var(--s9)", paddingBottom: "var(--s9)" }}
          >
            <div id="dashboard-composer" className="container" style={{ position: "relative", zIndex: 1, width: "100%" }}>
              {/* Two-column hero (matches the homepage): payoff + composer on the left,
                  a proof artifact on the right answering "what do I get after I describe
                  a goal?". One CTA (the composer). No competing buttons. */}
              <div className="hero-grid hero-grid--workspace">
                <div>
                  <p className="micro" style={{ marginBottom: "var(--s4)" }}>Your workspace</p>
                  <h1
                    className="dark-ink"
                    style={{ fontSize: "clamp(28px, 4.4vw, 42px)", lineHeight: 1.1, fontWeight: 300, letterSpacing: "-0.025em", marginBottom: "var(--s5)", maxWidth: "16ch" }}
                  >
                    Describe a goal. Get a real agent, <span className="dark-teal">running on your machine</span>.
                  </h1>
                  <p className="dark-ink-soft body-lg" style={{ maxWidth: "46ch", marginBottom: "var(--s6)" }}>
                    Type what you want done. Krelvan builds the agent, shows you the plan,
                    and runs it — keeping a signed record you can open and replay.
                  </p>

                  {/* the build box — the one and only CTA (same as homepage) */}
                  {composerInner}

                  <p className="dark-ink-muted small" style={{ marginTop: "var(--s5)" }}>
                    Runs on your machine · every step kept as a signed record you own
                  </p>
                </div>

                {/* right — a real run once one exists, else the animated demo (same as homepage) */}
                <div style={{ animation: "fade-in 400ms var(--ease) forwards" }}>
                  {latestCompleted ? <HeroArtifact run={latestCompleted} /> : <HeroAnimation />}
                </div>
              </div>
            </div>
          </section>

          {/* "what you can build" — fallback inspiration, deliberately BELOW the hero
              so it never co-stars with the single-action empty state. One-click
              examples with live mini graphs; solid borders only. */}
          <section className="container" style={{ paddingTop: "var(--s9)", paddingBottom: "var(--s9)" }}>
            <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: "var(--s3)", marginBottom: "var(--s5)" }}>
              <h2 className="micro" style={{ margin: 0 }}>Or start from an example</h2>
              <span className="small muted">Pick one to fill the composer above</span>
            </div>
            <div className="ws-gallery">
              {GALLERY.map(g => (
                <button
                  key={g.ex.label}
                  type="button"
                  className="ws-example"
                  onClick={() => pickExample(g.ex.text)}
                  aria-label={`Use example: ${g.ex.text}`}
                >
                  <span className="ws-example__label"><SparkGlyph size={13} />{g.ex.label}</span>
                  <div className="ws-example__graph">
                    <MiniGraph nodes={g.nodes} edges={g.edges} entry={g.entry} />
                  </div>
                  <span className="ws-example__text">{g.ex.text}</span>
                  <span style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: "var(--s2)" }}>
                    <span className="ws-example__cta">Use this →</span>
                  </span>
                </button>
              ))}
            </div>
          </section>
        </>
      )}

      {/* ════════════════════════════════════════════════════════════════════════
          INITIAL LOAD — quiet skeleton so we never flash the empty hero. */}
      {loading && !hasData && (
        <section style={{ background: "var(--canvas)", paddingTop: "var(--s9)", paddingBottom: "var(--s9)" }}>
          <div className="container">
            <div className="state-loading">
              <span className="spinner" aria-hidden="true" /> Loading your workspace…
            </div>
          </div>
        </section>
      )}

      {/* ════════════════════════════════════════════════════════════════════════
          POPULATED STATE — compact composer, stat strip, agents + runs. */}
      {hasData && (
        <>
          {/* compact composer — always accessible, never steals focus */}
          <section style={{ background: "var(--canvas)", paddingTop: "var(--s7)", paddingBottom: "var(--s5)" }}>
            <div id="dashboard-composer" className="container" style={{ maxWidth: 760 }}>
              {composerInner}
            </div>
          </section>

          {/* stat strip */}
          <div className="container" style={{ paddingBottom: "var(--s4)" }}>
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
          </div>

          {/* agents + activity */}
          <section className="container" style={{ paddingTop: "var(--s7)", paddingBottom: "var(--s9)" }}>
            <div className="builder-grid">

              {/* agent cards */}
              <div>
                <h2 className="micro" style={{ marginBottom: "var(--s5)" }}>Your agents</h2>

                {agents.length > 0 ? (
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
                      href="#dashboard-composer"
                      onClick={e => { e.preventDefault(); focusComposer(); }}
                      className="add-agent-tile"
                    >
                      <span className="add-agent-tile__plus" aria-hidden="true">+</span> New agent
                    </a>
                  </div>
                ) : (
                  // runs exist but no agents survive — a quiet, solid prompt (no dashed box)
                  <div className="card" style={{ padding: "var(--s8) var(--s6)", textAlign: "center", display: "flex", flexDirection: "column", alignItems: "center", gap: "var(--s3)" }}>
                    <span className="glyph-chip" style={{ width: 36, height: 36 }}><SparkGlyph size={20} /></span>
                    <p className="h3" style={{ color: "var(--ink)" }}>Build an agent to get started</p>
                    <p className="small soft" style={{ maxWidth: "32ch" }}>Describe a goal in the composer above. It compiles in ~<span className="mono">30</span> seconds.</p>
                  </div>
                )}
              </div>

              {/* recent runs */}
              <div>
                <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: "var(--s5)", gap: "var(--s3)" }}>
                  <h2 className="micro" style={{ margin: 0 }}>Recent runs</h2>
                  {running > 0 && (
                    <span className="small" style={{ display: "inline-flex", alignItems: "center", gap: "var(--s2)", color: "var(--live)", fontWeight: 500 }}>
                      <span className="status-dot running" />{running} live
                    </span>
                  )}
                </div>

                {recentRuns.length > 0 ? (
                  <div className="card" style={{ padding: 0, overflow: "hidden" }}>
                    {recentRuns.map(r => (
                      <Link
                        key={r.runId}
                        href={`/runs/${r.runId}`}
                        className={`run-row${r.status === "running" ? " is-live" : ""}`}
                      >
                        <span className={`status-dot run-row__dot ${r.status === "completed" ? "done" : r.status === "failed" ? "failed" : r.status === "running" ? "running" : "paused"}`} />
                        <div className="run-row__body">
                          <div className="small text-truncate run-row__title">{r.manifestName}</div>
                          <div className="run-row__meta">
                            <span className="small muted">{timeAgo(r.createdAt)}</span>
                            {r.status === "running" && (
                              <span className="run-row__live">
                                <span className="status-dot running" style={{ width: "var(--s2)", height: "var(--s2)" }} />running…
                              </span>
                            )}
                          </div>
                          {(r.status === "completed" || r.status === "failed") && (
                            <div className="run-ledger-strip">
                              <span className="run-ledger-strip__seal" style={{ display: "inline-flex" }}><SealGlyph size={11} /></span>
                              <span className="run-ledger-strip__tag">signed · replayable</span>
                            </div>
                          )}
                        </div>
                      </Link>
                    ))}
                  </div>
                ) : (
                  // agents exist but haven't run yet — solid, inviting (no dashed box)
                  <div className="card" style={{ padding: "var(--s7) var(--s5)", textAlign: "center", display: "flex", flexDirection: "column", alignItems: "center", gap: "var(--s2)" }}>
                    <span className="glyph-chip" style={{ width: 32, height: 32 }}><ClockGlyph size={18} /></span>
                    <span className="small" style={{ color: "var(--ink-soft)", fontWeight: 600 }}>No runs yet</span>
                    <span className="small muted" style={{ maxWidth: "24ch" }}>Run an agent and its signed record appears here.</span>
                  </div>
                )}

                <div style={{ marginTop: "var(--s3)" }}>
                  <Link href="/runs" className="small" style={{ color: "var(--brand)", fontWeight: 500 }}>All runs →</Link>
                </div>
              </div>

            </div>
          </section>
        </>
      )}
    </div>
  );
}
