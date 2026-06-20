"use client";
import { useState, useEffect, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  listAgents, listRuns, buildAgent, startRun, autoSummarizeRuns, timeAgo,
  type AgentRecord, type RunRecord, type BuildResult,
} from "../lib/api";
import {
  BuildPreviewModal, MiniGraph, HeroAnimation, EXAMPLES, BUILD_STAGES,
} from "./_builder";
import { loadRegistry, type CatalogEntry } from "../lib/registry";
import { glyphFor } from "../lib/glyphs";

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

// ── Example-agent gallery — the shipped templates, the proof of breadth ──────
// Loads the real registry (live, else bundled seed) and shows the flagship example
// agents so a first-time visitor SEES that Krelvan already does real jobs — price
// watching, RAG support, a personal advisor, an LLM-wiki, influencer outreach with a
// human-approval gate — installable in one click. This is the single highest-leverage
// "show the product" surface; it was previously hidden on /capabilities.
function ExampleGallery() {
  const [items, setItems] = useState<CatalogEntry[]>([]);
  const [counts, setCounts] = useState<{ total: number; agents: number; mcp: number }>({ total: 0, agents: 0, mcp: 0 });
  useEffect(() => {
    void loadRegistry().then(r => {
      const templates = r.entries.filter(e => e.kind === "template");
      setItems(templates.slice(0, 9));
      setCounts({
        total: r.entries.length,
        agents: templates.length,
        mcp: r.entries.filter(e => e.kind === "mcp").length,
      });
    }).catch(() => {});
  }, []);
  if (items.length === 0) return null;
  return (
    <section style={{ background: "var(--surface)", borderTop: "1px solid var(--line)" }}>
      <div className="container" style={{ paddingTop: "var(--s9)", paddingBottom: "var(--s9)" }}>
        <p className="micro" style={{ marginBottom: "var(--s3)" }}>Already built — not a demo</p>
        <h2 className="h1" style={{ marginBottom: "var(--s3)", maxWidth: "22ch" }}>
          Start from a <span style={{ color: "var(--brand)" }}>real agent</span>.
        </h2>
        <p className="body-lg soft" style={{ maxWidth: "60ch", marginBottom: "var(--s5)" }}>
          Install any of these in one click and watch it run — every step signed, the risky
          ones pausing for your approval. Then edit it, or build your own from scratch above.
        </p>
        {/* numbers-forward proof band — the real scale of what's shipped */}
        <div className="home-stats">
          <Link href="/capabilities" className="home-stat"><span className="home-stat__n mono">{counts.total}</span><span className="home-stat__l">capabilities</span></Link>
          <span className="home-stat__div" aria-hidden="true" />
          <Link href="/capabilities" className="home-stat"><span className="home-stat__n mono">{counts.agents}</span><span className="home-stat__l">ready-to-run agents</span></Link>
          <span className="home-stat__div" aria-hidden="true" />
          <Link href="/capabilities?install=&kind=mcp" className="home-stat"><span className="home-stat__n mono">{counts.mcp}</span><span className="home-stat__l">MCP connectors</span></Link>
        </div>
        <div className="home-examples">
          {items.map(e => (
            <Link key={e.name} href={`/capabilities?install=${encodeURIComponent(e.name)}`} className="home-example card">
              <span className="home-example__icon" aria-hidden="true">
                <svg viewBox="0 0 16 16" width={18} height={18} fill="none">
                  <path d={glyphFor(e.name, e.category, e.kind)} stroke="currentColor" strokeWidth={1.3} strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </span>
              <div style={{ minWidth: 0 }}>
                <div className="home-example__title">{e.title}</div>
                <div className="home-example__desc small soft">{e.oneLiner}</div>
                <div className="home-example__cta small">Install &amp; run →</div>
              </div>
            </Link>
          ))}
        </div>
        <div style={{ marginTop: "var(--s6)" }}>
          <Link href="/capabilities" className="btn btn-secondary btn-sm">Browse all {items.length >= 9 ? "agents & connectors" : "agents"} →</Link>
        </div>
      </div>
    </section>
  );
}

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
      <Link
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
      </Link>
    );
  }

  // No real run yet → labelled live example (the pre-built research-digest graph).
  return (
    <div className="dark-device" style={{ padding: "var(--s5)" }}>
      <div className="micro" style={{ marginBottom: "var(--s3)" }}>Example graph · not yet run</div>
      <div
        className="dark-surface-2"
        style={{ borderRadius: "var(--r)", padding: "var(--s5)", display: "flex", flexDirection: "column", gap: "var(--s4)" }}
      >
        <div style={{ background: "var(--dark-node-fill)", borderRadius: "var(--r)", padding: "var(--s5)", border: "1px solid var(--dark-line)" }}>
          <MiniGraph nodes={EXAMPLE_NODES} edges={EXAMPLE_EDGES} entry="entry" variant="dark" maxHeight={120} />
        </div>
        {/* Honest: NOTHING has run, so we never show the signed seal here — only on real runs. */}
        <div style={{ display: "flex", alignItems: "center", gap: "var(--s2)", flexWrap: "wrap" }}>
          <span className="dark-ink-muted mono" style={{ fontSize: 13 }}>3 steps · runs and signs once you build it</span>
        </div>
        <div className="dark-ink-muted small">
          Build your own below — your real, signed runs show up here.
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

  // Background one-line summaries — BOUNDED so we don't fire one LLM call per run on load
  // (which can flood the single-process API). Only the most recent few, low concurrency.
  useEffect(() => {
    const pending = runs
      .filter(r => r.status === "completed" && summaries[r.runId] === undefined && !fetchingSummaries.current.has(r.runId))
      .map(r => r.runId);
    if (pending.length === 0) return;
    pending.forEach(id => fetchingSummaries.current.add(id));
    const cancel = autoSummarizeRuns(pending, (runId, summary) => {
      setSummaries(prev => ({ ...prev, [runId]: summary }));
    });
    return cancel;
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

  // Most recent completed run — the real artifact for the hero + the latest-run highlight.
  // runs come newest-first from the API, so the first completed one is the latest.
  const latestCompleted = runs.find(r => r.status === "completed") ?? null;

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
              <p className="micro" style={{ marginBottom: "var(--s4)" }}>The agent platform that proves its work</p>
              <h1
                className="display dark-ink"
                style={{ fontSize: "clamp(40px, 5.5vw, 64px)", lineHeight: 1.04, fontWeight: 600, letterSpacing: "-0.03em", marginBottom: "var(--s5)" }}
              >
                AI agents that <span className="dark-teal">prove what they did</span>.
              </h1>
              <p className="dark-ink-soft body-lg" style={{ maxWidth: "52ch", marginBottom: "var(--s5)" }}>
                Describe a goal in plain English. Krelvan builds the agent, signs every step it
                takes to a tamper-evident, replayable record, and pauses for your approval before
                anything risky — all self-hosted, on infrastructure you own.
              </p>
              <div style={{ display: "flex", gap: "var(--s3)", flexWrap: "wrap" }}>
                <button className="btn btn-dark-primary btn-lg" onClick={focusBuilder}>
                  Build an agent
                </button>
                {latestCompleted ? (
                  <Link href={`/runs/${latestCompleted.runId}`} className="btn btn-dark-ghost btn-lg">
                    See a signed run
                  </Link>
                ) : (
                  <button className="btn btn-dark-ghost btn-lg" onClick={focusBuilder}>
                    Try an example
                  </button>
                )}
              </div>
              <div className="hero-trustline">
                <a href="https://github.com/sreenathmmenon/krelvan" className="hero-trustline__item">
                  <svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor" aria-hidden="true"><path d="M8 1.6a6.4 6.4 0 0 0-2 12.5c.3.06.43-.14.43-.3v-1.1c-1.8.4-2.2-.85-2.2-.85-.3-.75-.72-.95-.72-.95-.6-.4.04-.4.04-.4.65.05 1 .67 1 .67.58 1 1.5.7 1.9.55.06-.43.23-.7.42-.87-1.45-.16-2.97-.72-2.97-3.2 0-.7.25-1.3.66-1.74-.07-.16-.29-.82.06-1.7 0 0 .54-.18 1.78.66a6.1 6.1 0 0 1 3.24 0c1.24-.84 1.78-.66 1.78-.66.35.88.13 1.54.06 1.7.41.44.66 1.04.66 1.74 0 2.49-1.52 3.04-2.97 3.2.23.2.44.6.44 1.2v1.78c0 .17.12.37.44.3A6.4 6.4 0 0 0 8 1.6z"/></svg>
                  Open source
                </a>
                <span className="hero-trustline__sep" aria-hidden="true" />
                <span className="hero-trustline__item">Apache-2.0</span>
                <span className="hero-trustline__sep" aria-hidden="true" />
                <span className="hero-trustline__item">Self-hosted · zero third-party auth deps</span>
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

              {buildError && /no llm provider/i.test(buildError) ? (
                <div role="alert" className="build-needs-model" style={{ margin: "var(--s4) 0 0" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "var(--s2)", marginBottom: "var(--s2)" }}>
                    <svg viewBox="0 0 16 16" width="16" height="16" fill="none" aria-hidden="true"><path d="M8 1.6l1.7 4.7L14.4 8l-4.7 1.7L8 14.4l-1.7-4.7L1.6 8l4.7-1.7L8 1.6z" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/></svg>
                    <span style={{ fontWeight: 700 }}>Connect a model to build agents</span>
                  </div>
                  <p className="small soft" style={{ margin: "0 0 var(--s3)", lineHeight: 1.55 }}>
                    Building an agent needs a language model. Point Krelvan at one — an API key
                    (Anthropic, OpenAI…) or a local Ollama — then come back and build.
                  </p>
                  <Link href="/secrets#model" className="btn btn-primary btn-sm">Connect a model →</Link>
                </div>
              ) : buildError ? (
                <div role="alert" className="state-error" style={{ margin: "var(--s4) 0 0", justifyContent: "space-between" }}>
                  <span>{buildError}</span>
                  <button
                    onClick={() => setBuildError(null)}
                    aria-label="Dismiss error"
                    style={{ background: "none", border: "none", cursor: "pointer", color: "var(--danger)", fontSize: 16, lineHeight: 1, flexShrink: 0, padding: "0 var(--s1)" }}
                  >×</button>
                </div>
              ) : null}

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

        {/* ════════════ 3 · LATEST-RUN HIGHLIGHT (returning users only) ════════════ */}
        {/* The homepage is NOT the workspace. The full agent grid, stats, and recent-runs
            panel live only at /dashboard. Here, a returning visitor sees a single
            real-run highlight as proof, with one link into the workspace. */}
        {latestCompleted && (
          <div className="container" style={{ paddingTop: "var(--s4)", paddingBottom: "var(--s9)" }}>
            <Link
              href={`/runs/${latestCompleted.runId}`}
              className="card card-hover ledger-artifact"
              style={{
                display: "flex", alignItems: "center", justifyContent: "space-between",
                gap: "var(--s5)", padding: "var(--s5) var(--s6)", maxWidth: 720, margin: "0 auto",
                textDecoration: "none", flexWrap: "wrap",
              }}
            >
              <div style={{ minWidth: 0 }}>
                <div className="micro" style={{ marginBottom: "var(--s2)" }}>Your latest run</div>
                <div className="h3" style={{ color: "var(--ink)" }}>{latestCompleted.manifestName}</div>
                <div className="small muted" style={{ marginTop: "var(--s1)" }}>
                  {timeAgo(latestCompleted.createdAt)} · <span className="mono" style={{ color: "var(--brand)", fontWeight: 600 }}>✓ signed · replayable</span>
                </div>
              </div>
              <span className="btn btn-secondary">Open this record →</span>
            </Link>
            <div style={{ textAlign: "center", marginTop: "var(--s4)" }}>
              <Link href="/dashboard" className="small" style={{ color: "var(--brand)" }}>Go to your workspace →</Link>
            </div>
          </div>
        )}
      </section>

      {/* ════════════ 3.5 · EXAMPLE-AGENT GALLERY (the proof of breadth) ════════════ */}
      <ExampleGallery />

      {/* ════════════ 3.7 · WHY NOT A RAW FRAMEWORK (the contrast) ════════════ */}
      <section style={{ background: "var(--canvas)", borderTop: "1px solid var(--line)" }}>
        <div className="container" style={{ paddingTop: "var(--s9)", paddingBottom: "var(--s9)" }}>
          <p className="micro" style={{ marginBottom: "var(--s3)" }}>Why Krelvan</p>
          <h2 className="display h1" style={{ marginBottom: "var(--s3)", maxWidth: "24ch" }}>
            A framework gives you parts. Krelvan gives you the <span style={{ color: "var(--brand)" }}>whole thing — proven</span>.
          </h2>
          <p className="body-lg soft" style={{ maxWidth: "60ch", marginBottom: "var(--s7)" }}>
            You could wire this yourself in a raw agent framework. Then you own the hard parts forever.
          </p>
          <div className="contrast-grid">
            {[
              { a: "Write the graph, the runner, the retries", b: "Describe a goal — the agent is built and run for you" },
              { a: "Bolt on your own audit log (and trust it)", b: "Every step is signed to a tamper-evident, replayable record" },
              { a: "Hand-roll a human-in-the-loop gate", b: "Risky steps pause and show you exactly what they'll do" },
              { a: "Debug failures by reading logs", b: "It reasons about why a run failed — and rebuilds a fix" },
            ].map((r, i) => (
              <div key={i} className="contrast-row">
                <div className="contrast-row__a">
                  <span className="contrast-row__tag">Raw framework</span>
                  <span>{r.a}</span>
                </div>
                <div className="contrast-row__b">
                  <span className="contrast-row__tag contrast-row__tag--on">Krelvan</span>
                  <span>{r.b}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ════════════ 4 · FINAL CTA (dark) ════════════ */}
      {/* Build-on-Krelvan — the platform-base value prop: eliminated decisions. */}
      <section style={{ background: "var(--canvas)", borderTop: "1px solid var(--line)" }}>
        <div className="container" style={{ paddingTop: "var(--s9)", paddingBottom: "var(--s9)" }}>
          <p className="micro" style={{ marginBottom: "var(--s3)" }}>Build on it</p>
          <h2 className="h1" style={{ marginBottom: "var(--s3)", maxWidth: "24ch" }}>
            The hard parts, <span style={{ color: "var(--brand)" }}>already solved</span>.
          </h2>
          <p className="body-lg soft" style={{ maxWidth: "58ch", marginBottom: "var(--s7)" }}>
            Audit, memory, approvals and failure-reasoning come built in. You build the
            domain logic and the client workflow — and ship agentic solutions in days.
          </p>
          <div className="build-on-grid">
            {[
              { k: "Audit by default", v: "Every step signed to a tamper-evident record you can replay.", href: "/runs", cta: "See a signed run" },
              { k: "Memory", v: "Episodic, semantic and trust-aware — right by default.", href: "/capabilities?install=personal-advisor", cta: "Try the advisor" },
              { k: "Approval flows", v: "Human-in-the-loop pause / approve / resume on risky actions.", href: "/approvals", cta: "Open approvals" },
              { k: "Failure-reasoning", v: "It reasons about why a run failed — and rebuilds a fix.", href: "/runs", cta: "Explain a run" },
            ].map(c => (
              <Link key={c.k} href={c.href} className="card build-on-card" style={{ padding: "var(--s5)", textDecoration: "none", color: "inherit", display: "block" }}>
                <div className="h3" style={{ color: "var(--ink)", marginBottom: "var(--s2)", display: "flex", alignItems: "center", gap: "var(--s2)" }}>
                  <span aria-hidden="true" style={{ color: "var(--brand)", display: "inline-flex" }}>
                    <svg viewBox="0 0 16 16" width="16" height="16" fill="none"><path d="M3.5 8.5l3 3 6-6.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/></svg>
                  </span>
                  {c.k}
                </div>
                <p className="small soft" style={{ margin: "0 0 var(--s3)", lineHeight: 1.55 }}>{c.v}</p>
                <span className="small" style={{ color: "var(--brand)", fontWeight: 600 }}>{c.cta} →</span>
              </Link>
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
            Your keys, your data, your infrastructure.
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
