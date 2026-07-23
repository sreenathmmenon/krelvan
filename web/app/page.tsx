"use client";
import { useState, useEffect, useCallback, useRef, Fragment } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  listAgents, listRuns, buildAgent, startRun, autoSummarizeRuns, getStatus, getAuthStatus, timeAgo,
  type AgentRecord, type RunRecord, type BuildResult,
} from "../lib/api";
import {
  BuildPreviewModal, MiniGraph, EXAMPLES, BUILD_STAGES,
} from "./_builder";
import { loadRegistry, type CatalogEntry } from "../lib/registry";
import { glyphFor, UI } from "../lib/glyphs";
import { MARKETING_ONLY } from "../lib/deployment";

// ── Krelvan landing — product-first debut ──────────────────────────────────────
// The homepage IS the working product. On first paint a visitor lands on a dark
// hero whose right side is a real, inspectable registry manifest, with a CTA that
// drops straight into the embedded builder one
// screen below. Within seconds they can describe a goal, watch a real graph compile
// in the BuildPreviewModal, run it, and open /runs/[id] to see the actual
// replayable record. We demonstrate ownership by letting you DO and SEE
// it — never by lecturing about internals. The builder data path is unchanged:
// same buildAgent / startRun / explainRun as /dashboard; only the page IA + copy.

function HeroBuildPanel() {
  const [entry, setEntry] = useState<CatalogEntry | null>(null);

  useEffect(() => {
    void loadRegistry()
      .then(registry => {
        const templates = registry.entries
          .filter(item => item.kind === "template" && item.manifest)
          .sort((a, b) => a.manifest!.nodes.length - b.manifest!.nodes.length);
        setEntry(templates[0] ?? null);
      })
      .catch(() => setEntry(null));
  }, []);

  const manifest = entry?.manifest;

  return (
    <div className="hero-build" aria-label="Inspectable agent manifest from the Krelvan registry">
      <div className="hero-build__bar">
        <span className="hero-build__dots" aria-hidden="true"><i /><i /><i /></span>
        <span className="hero-build__title mono">registry/index.json</span>
      </div>
      <div className="hero-build__body">
        <div className="hero-build__prompt">
          {manifest ? manifest.intent : "Loading an inspectable registry agent…"}
        </div>
        {manifest && (
        <div className="hero-build__result is-in">
          <div className="hero-build__resulthead mono">
            <span className="hero-build__ok" aria-hidden="true">
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M3.5 8.5l3 3 6-6.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
            </span>
            real registry manifest · {manifest.nodes.length} {manifest.nodes.length === 1 ? "node" : "nodes"}
          </div>
          <MiniGraph
            nodes={manifest.nodes}
            edges={manifest.edges.map(edge => ({ from: edge.from, to: edge.to }))}
            entry={manifest.entry}
            variant="dark"
            maxHeight={150}
          />
          <Link href={`/marketplace?entry=${encodeURIComponent(entry.name)}`} className="dark-teal mono" style={{ fontSize: 12 }}>
            Inspect {entry.title} →
          </Link>
        </div>
        )}
      </div>
    </div>
  );
}

// ── Example-agent gallery — the shipped templates, the proof of breadth ──────
// Loads the real registry (live, else bundled seed) and shows the flagship example
// agents so a first-time visitor SEES that Krelvan already does real jobs — price
// watching, RAG support, a personal advisor, an LLM-wiki, influencer outreach with a
// human-approval gate — installable in one click. This is the single highest-leverage
// "show the product" surface; it was previously hidden on /capabilities.

// Real integrations only — the recognizable connectors that actually ship in the registry.
const CONNECTORS = ["Stripe", "GitHub", "Notion", "Slack", "Linear", "Shopify", "HubSpot", "Airtable", "Qdrant", "ElevenLabs", "Google Workspace", "Resend"];
function ConnectorStrip() {
  return (
    <div className="connector-strip" aria-label="Works with real integrations">
      <span className="connector-strip__label micro">Works with</span>
      <div className="connector-strip__row">
        {CONNECTORS.map(c => <span key={c} className="connector-chip mono">{c}</span>)}
        <Link href="/marketplace" className="connector-chip connector-chip--more mono">+ more →</Link>
      </div>
    </div>
  );
}

// Live GitHub star count — REAL number from the GitHub API, never fabricated. Renders
// nothing until a real count loads (a brand-new repo with 0 stars simply shows no badge,
// so we never invent social proof). Honest by construction.
function GitHubStars() {
  const [stars, setStars] = useState<number | null>(null);
  useEffect(() => {
    // Best-effort star count. If the repo is private/unpublished the API returns 404 — we swallow
    // it silently and simply render nothing, so the "Star on GitHub" button stays clean either way.
    const ctrl = new AbortController();
    void fetch("https://api.github.com/repos/sreenathmmenon/krelvan", { signal: ctrl.signal })
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d && typeof d.stargazers_count === "number" && d.stargazers_count > 0) setStars(d.stargazers_count); })
      .catch(() => {});
    return () => ctrl.abort();
  }, []);
  if (stars === null) return null;
  const label = stars >= 1000 ? `${(stars / 1000).toFixed(1)}k` : String(stars);
  return (
    <span className="gh-stars" aria-label={`${stars} GitHub stars`}>
      <svg width="11" height="11" viewBox="0 0 16 16" aria-hidden="true" style={{ verticalAlign: "-1px", marginRight: 3 }}>
        <path d="M8 1.5l1.85 3.9 4.15.55-3 2.95.75 4.15L8 11.6l-3.7 1.95.75-4.15-3-2.95 4.15-.55z" fill="currentColor" />
      </svg>
      {label}
    </span>
  );
}

// Hero stat strip — surfaces the depth (real registry counts) loudly under the hero
// CTAs instead of whispering "7 LLM providers" in micro-copy. Numbers are live.
function HeroStatStrip() {
  const [c, setC] = useState<{ total: number; agents: number; mcp: number } | null>(null);
  useEffect(() => {
    void loadRegistry().then(r => setC({
      total: r.entries.length,
      agents: r.entries.filter(e => e.kind === "template").length,
      mcp: r.entries.filter(e => e.kind === "mcp").length,
    })).catch(() => {});
  }, []);
  // Four parallel count stats in a clean grid; "100% offline-verifiable" is NOT a
  // count — it's the proof claim, so it gets its own distinct highlight chip below
  // the row instead of hanging as an orphaned 5th cell.
  // Each stat links to the page that PROVES it — on a "don't trust claims, verify them"
  // product, a number the visitor can't click to is just marketing.
  const stats = [
    { n: c ? String(c.total) : "—", l: "marketplace entries", href: "/marketplace" },
    { n: c ? String(c.agents) : "—", l: "agent templates", href: "/marketplace" },
    { n: c ? String(c.mcp) : "—", l: "MCP connectors", href: "/marketplace" },
    { n: "7", l: "LLM providers", href: "/faq" },
  ];
  return (
    <div className="hero-statwrap">
      <div className="hero-statstrip" aria-label="what ships with Krelvan">
        {stats.map((s) => (
          <Link key={s.l} href={s.href} className="hero-statstrip__cell" style={{ textDecoration: "none" }}>
            <span className="hero-statstrip__n mono">{s.n}</span>
            <span className="hero-statstrip__l">{s.l}</span>
          </Link>
        ))}
      </div>
      <span className="hero-statwrap__claim">
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d={UI.check} stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></svg>
        runs on any LLM, or fully local
      </span>
    </div>
  );
}

function ExampleGallery() {
  const [items, setItems] = useState<CatalogEntry[]>([]);
  useEffect(() => {
    void loadRegistry().then(r => {
      setItems(r.entries.filter(e => e.kind === "template").slice(0, 9));
    }).catch(() => {});
  }, []);
  if (items.length === 0) return null;
  return (
    <section id="marketplace" style={{ background: "var(--surface)", borderTop: "1px solid var(--line)", scrollMarginTop: "var(--s6)" }}>
      <div className="container" style={{ paddingTop: "var(--s9)", paddingBottom: "var(--s9)" }}>
        <p className="micro" style={{ marginBottom: "var(--s3)" }}>The marketplace is a Git repo — clone it, read it, run it</p>
        <h2 className="display h1" style={{ marginBottom: "var(--s3)", maxWidth: "24ch" }}>
          Start from a <span style={{ color: "var(--brand)" }}>real agent</span> — or audit one before you trust it.
        </h2>
        <p className="body-lg soft" style={{ maxWidth: "62ch", marginBottom: "var(--s5)" }}>
          No hosted black box. Every entry is an inspectable file in a public registry. In your
          installation, install an entry and watch it run with risky steps pausing for approval.
        </p>
        {/* The depth numbers live in the hero stat strip above the fold; this section is
            about BROWSING, so it leads with the real integrations + the example agents
            instead of repeating the same four counts verbatim (council: earn the space). */}
        {/* real integrations — only connectors that actually ship in the registry */}
        <ConnectorStrip />
        <div className="home-examples">
          {items.map(e => (
            <Link key={e.name} href={`/marketplace?entry=${encodeURIComponent(e.name)}`} className="home-example card">
              <span className="home-example__icon" aria-hidden="true">
                <svg viewBox="0 0 16 16" width={18} height={18} fill="none">
                  <path d={glyphFor(e.name, e.category, e.kind)} stroke="currentColor" strokeWidth={1.3} strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </span>
              <div style={{ minWidth: 0 }}>
                <div className="home-example__title">{e.title}</div>
                <div className="home-example__desc small soft">{e.oneLiner}</div>
                <div className="home-example__cta small">Inspect →</div>
              </div>
            </Link>
          ))}
        </div>
        <div style={{ marginTop: "var(--s6)" }}>
          <Link href="/marketplace" className="btn btn-secondary btn-sm">Browse all {items.length >= 9 ? "agents & connectors" : "agents"} →</Link>
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
        {copied
          ? <><svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true" style={{ marginRight: 4, verticalAlign: "-1px" }}><path d={UI.check} stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></svg>Copied</>
          : "Copy"}
      </button>
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
  const [heroCopied, setHeroCopied] = useState(false);
  const [buildError, setBuildError] = useState<string | null>(null);
  const [buildResult, setBuildResult] = useState<BuildResult | null>(null);
  const [agents, setAgents] = useState<AgentRecord[]>([]);
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [composeFocused, setComposeFocused] = useState(false);
  const [summaries, setSummaries] = useState<Record<string, string | null>>({});
  const [modelReady, setModelReady] = useState<boolean | null>(null);
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const fetchingSummaries = useRef<Set<string>>(new Set());

  const reload = useCallback(async () => {
    // The homepage is public. Never read private agent/run data from it, even if
    // an old session cookie happens to exist; private history belongs in the
    // authenticated dashboard. Build/run actions below remain auth-gated.
    if (typeof window !== "undefined" && window.location.pathname === "/") {
      setLoading(false);
      return;
    }
    try {
      const [a, r] = await Promise.all([listAgents(), listRuns()]);
      setAgents(a);
      setRuns(r);
    } catch { /* a later authenticated poll can recover */ }
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
    if (MARKETING_ONLY) {
      setAuthenticated(false);
      setLoading(false);
      return;
    }
    void getAuthStatus()
      .then(status => setAuthenticated(status.authenticated))
      .catch(() => setAuthenticated(false));
  }, []);

  useEffect(() => {
    if (authenticated !== true) {
      if (authenticated === false) setLoading(false);
      return;
    }
    void reload();
    const t = setInterval(() => void reload(), 3000);
    return () => clearInterval(t);
  }, [authenticated, reload]);

  // Model readiness — drives the build gate + the "Model connected" pill.
  useEffect(() => {
    if (MARKETING_ONLY) return;
    void getStatus().then(s => setModelReady(s.hasLlm)).catch(() => setModelReady(null));
  }, []);

  // Cycle build-stage messages while building (same cadence as the workspace)
  useEffect(() => {
    if (!building) { setBuildStage(0); return; }
    const t = setInterval(() => setBuildStage(s => (s + 1) % BUILD_STAGES.length), 3500);
    return () => clearInterval(t);
  }, [building]);

  async function handleBuild(e: React.FormEvent) {
    e.preventDefault();
    if (building) return;
    // Empty goal: don't error — just guide the eye back to the textarea.
    if (!intent.trim()) {
      document.querySelector<HTMLTextAreaElement>("textarea")?.focus();
      return;
    }
    if (MARKETING_ONLY) {
      setBuildError("DOWNLOAD_REQUIRED");
      return;
    }
    if (authenticated !== true) {
      sessionStorage.setItem("krelvan_pending_intent", intent.trim());
      setBuildError("SIGN_IN_REQUIRED");
      return;
    }
    if (modelReady === false) {
      setBuildError("no model configured");
      return;
    }
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
      <section className="hero-dark" style={{ minHeight: "clamp(620px, 80vh, 840px)", display: "flex", alignItems: "center", paddingTop: "var(--s9)", paddingBottom: "var(--s9)" }}>
        <div className="container" style={{ position: "relative", zIndex: 1, width: "100%" }}>
          <div className="hero-grid">
            {/* left — payoff + CTAs (42%) */}
            <div>
              <span className="hero-eyebrow-pill"><i aria-hidden="true" /> Open-source · self-hosted</span>
              <h1
                className="display dark-ink hero-headline"
                style={{ fontSize: "clamp(40px, 4.4vw, 62px)", lineHeight: 1.04, fontWeight: 500, letterSpacing: "-0.035em", marginBottom: "var(--s5)", textWrap: "balance", maxWidth: "19ch" }}
              >
                <span style={{ color: "#C8C4BC", fontWeight: 500 }}>Write a sentence.</span>{" "}
                <span style={{ color: "#fff", fontWeight: 800 }}>Get a working agent <span className="hero-grad-word">system.</span></span>
              </h1>
              <p className="dark-ink-soft body-lg" style={{ maxWidth: "52ch", marginBottom: "var(--s5)" }}>
                Krelvan turns plain English into real agents that act across your tools and run
                on your schedule. Extend it from an open Git registry, or publish your own
                inspectable entry through the registry review process.
              </p>
              <div style={{ display: "flex", gap: "var(--s3)", flexWrap: "wrap", marginTop: "var(--s2)" }}>
                {/* Primary CTA matches the headline: the product is BUILD-first. */}
                <button className="btn btn-dark-primary btn-lg" onClick={focusBuilder}>
                  Build an agent →
                </button>
                <a href="https://github.com/sreenathmmenon/krelvan" className="btn btn-dark-ghost btn-lg" style={{ display: "inline-flex", alignItems: "center", gap: "var(--s2)" }}>
                  <svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true"><path d="M8 1.6a6.4 6.4 0 0 0-2 12.5c.3.06.43-.14.43-.3v-1.1c-1.8.4-2.2-.85-2.2-.85-.3-.75-.72-.95-.72-.95-.6-.4.04-.4.04-.4.65.05 1 .67 1 .67.58 1 1.5.7 1.9.55.06-.43.23-.7.42-.87-1.45-.16-2.97-.72-2.97-3.2 0-.7.25-1.3.66-1.74-.07-.16-.29-.82.06-1.7 0 0 .54-.18 1.78.66a6.1 6.1 0 0 1 3.24 0c1.24-.84 1.78-.66 1.78-.66.35.88.13 1.54.06 1.7.41.44.66 1.04.66 1.74 0 2.49-1.52 3.04-2.97 3.2.23.2.44.6.44 1.2v1.78c0 .17.12.37.44.3A6.4 6.4 0 0 0 8 1.6z"/></svg>
                  Star on GitHub
                  <GitHubStars />
                </a>
              </div>
              <HeroStatStrip />
            </div>

            {/* right — the BUILD MAGIC, above the fold: a plain-English sentence typing in,
                then the real agent SYSTEM it compiles into. This makes the headline
                ("write a sentence, get a working agent system") visible, not just claimed. */}
            <div style={{ animation: "fade-in 400ms var(--ease) forwards" }}>
              <HeroBuildPanel />
            </div>
          </div>
        </div>
      </section>

      {/* ════════════ 2 · EMBEDDED LIVE BUILDER (the product, first) ════════════ */}
      {/* The exact workspace composer + BuildPreviewModal + stat strip + agents/runs.
          Same data path (buildAgent / startRun / explainRun) as /dashboard.
          This is the dominant first-interaction zone, right under the hero — the PRODUCT
          leads, so the page shows what you can build first. */}
      <section id="builder" className="builder-zone" style={{ scrollMarginTop: "var(--s6)" }}>
        <div className="container" style={{ paddingTop: "var(--s8)", paddingBottom: "var(--s8)", textAlign: "center" }}>
          <h2 className="h1" style={{ marginBottom: "var(--s3)" }}>
            {MARKETING_ONLY ? "Start with a goal. Run it on your own machine." : "Build and run an agent."}
          </h2>
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
              <div className="build-box__head" style={{ justifyContent: "space-between" }}>
                <span style={{ display: "inline-flex", alignItems: "center", gap: "var(--s2)" }}>
                  <span className="build-box__badge" aria-hidden="true">
                    <svg viewBox="0 0 16 16" width="14" height="14" fill="none">
                      <path d="M8 1.6l1.7 4.7L14.4 8l-4.7 1.7L8 14.4l-1.7-4.7L1.6 8l4.7-1.7L8 1.6z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
                    </svg>
                  </span>
                  <span className="micro" style={{ color: "var(--ink-soft)" }}>Describe your agent</span>
                </span>
                {MARKETING_ONLY && (
                  <span className="model-pill model-pill--on" title="The public website does not run private agents">
                    <span className="model-pill__dot" /> Runs in your install
                  </span>
                )}
                {!MARKETING_ONLY && authenticated === false && (
                  <Link href="/login" className="model-pill model-pill--off" title="Sign in to build and run this goal">
                    <span className="model-pill__dot" /> Sign in to build
                  </Link>
                )}
                {authenticated === true && modelReady === true && (
                  <span className="model-pill model-pill--on" title="A model is connected — you can build agents">
                    <span className="model-pill__dot" /> Model connected
                  </span>
                )}
                {authenticated === true && modelReady === false && (
                  <Link href="/secrets#model" className="model-pill model-pill--off" title="No model configured — building is disabled">
                    <span className="model-pill__dot" /> Connect a model
                  </Link>
                )}
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

              {buildError === "DOWNLOAD_REQUIRED" ? (
                <div role="status" className="build-needs-model" style={{ margin: "var(--s4) 0 0", textAlign: "left" }}>
                  <div style={{ fontWeight: 700, marginBottom: "var(--s2)" }}>Run this goal in your own Krelvan</div>
                  <p className="small soft" style={{ margin: "0 0 var(--s3)", lineHeight: 1.55 }}>
                    The public website is read-only and has no shared customer accounts. Download Krelvan,
                    connect your model, and build this goal with your data staying in your installation.
                  </p>
                  <a href="https://github.com/sreenathmmenon/krelvan#run-it" className="btn btn-primary btn-sm">Download and run →</a>
                </div>
              ) : buildError === "SIGN_IN_REQUIRED" ? (
                <div role="alert" className="build-needs-model" style={{ margin: "var(--s4) 0 0", textAlign: "left" }}>
                  <div style={{ fontWeight: 700, marginBottom: "var(--s2)" }}>Sign in to build this agent</div>
                  <p className="small soft" style={{ margin: "0 0 var(--s3)", lineHeight: 1.55 }}>
                    Your goal is saved in this browser tab. After you sign in, Krelvan will put it back in the workspace composer.
                  </p>
                  <Link href="/login" className="btn btn-primary btn-sm">Sign in and continue →</Link>
                </div>
              ) : buildError && /no (llm|model)/i.test(buildError) ? (
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
                    style={{ background: "none", border: "none", cursor: "pointer", color: "var(--danger)", lineHeight: 1, flexShrink: 0, padding: "0 var(--s1)", display: "inline-flex" }}
                  ><svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg></button>
                </div>
              ) : null}

              <div className="build-box__foot">
                <div className="small" style={{ color: "var(--ink-muted)", minHeight: 18, textAlign: "left" }}>
                  {building
                    ? <span key={buildStage} style={{ animation: "fade-in 150ms ease forwards" }}>{BUILD_STAGES[buildStage]}</span>
                    : <span>You review the plan before anything runs.</span>}
                </div>
                {/* Keep the primary CTA visually LIVE at the strongest conversion moment —
                    a greyed button on an empty textarea reads as broken. Only truly disabled
                    while a build is in flight; an empty goal is nudged, not blocked. */}
                <button
                  type="submit"
                  className="btn btn-primary btn-lg"
                  disabled={building}
                  aria-disabled={!intent.trim()}
                  title={!intent.trim() ? "Type a goal above to build your agent" : undefined}
                  style={{ minWidth: 150 }}
                >
                  {building ? "Building…" : MARKETING_ONLY ? "Run on my machine →" : "Build agent →"}
                </button>
              </div>
            </form>
          </div>
        </div>

        {/* ════════════ 3 · LATEST-RUN HIGHLIGHT (returning users only) ════════════ */}
        {/* The homepage is NOT the workspace. The full agent grid, stats, and recent-runs
            panel live only at /dashboard. Here, a returning visitor sees a single
            real-run highlight, with one link into the workspace. */}
        {latestCompleted && (
          <div className="container" style={{ paddingTop: "var(--s4)", paddingBottom: "var(--s9)" }}>
            <Link
              href={`/runs/${latestCompleted.runId}`}
              className="card card-hover record-artifact"
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
                  {timeAgo(latestCompleted.createdAt)} · <span className="mono" style={{ color: "var(--brand)", fontWeight: 600 }}>complete · replayable</span>
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

      {/* ════════════ 3.4 · THE ACTUAL PRODUCT (show, don't tell) ════════════ */}
      {/* A skeptic wants to SEE the app, not another terminal. This is a real screenshot
          of the canvas — the graph that maps 1:1 to what executed. */}
      <section style={{ background: "var(--surface)", borderTop: "1px solid var(--line)" }}>
        <div className="container" style={{ paddingTop: "var(--s9)", paddingBottom: "var(--s9)" }}>
          <p className="micro" style={{ marginBottom: "var(--s3)" }}>The canvas is the runtime</p>
          <h2 className="h1" style={{ marginBottom: "var(--s3)", maxWidth: "20ch" }}>
            What you see <span style={{ color: "var(--brand)" }}>is what runs.</span>
          </h2>
          <p className="body-lg soft" style={{ maxWidth: "56ch", marginBottom: "var(--s6)" }}>
            Every node is a real step, every edge a real branch, and each run replays over the
            same recorded run — so the graph is not a diagram of the agent, it is the agent.
          </p>
          <figure style={{ margin: 0, borderRadius: "var(--r-xl, 16px)", overflow: "hidden", border: "1px solid var(--line)", boxShadow: "var(--shadow-lg)", background: "var(--graph-bg)" }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/product-canvas.png" alt="The Krelvan canvas showing a 12-node support agent: triage, retrieve, judge with a revise loop, route, send, escalate — each step a real recorded event."
              width={1400} height={640} loading="lazy" style={{ display: "block", width: "100%", height: "auto" }} />
          </figure>
        </div>
      </section>

      {/* ════════════ 3.5 · EXAMPLE-AGENT GALLERY (the marketplace — breadth) ════════════ */}
      <ExampleGallery />

      {/* ════════════ 3.6 · DELIVER ANYWHERE (the payoff, made literal) ════════════ */}
      {/* Output isn't just produced — it's DELIVERED where you already are. One result fans
          out to every channel. This turns the delivery differentiator into a moving diagram. */}
      <section className="hero-dark deliver-band">
        <div className="container" style={{ paddingTop: "var(--s9)", paddingBottom: "var(--s9)", textAlign: "center" }}>
          <p className="micro dark-teal" style={{ marginBottom: "var(--s3)" }}>Output where you live</p>
          <h2 className="display dark-ink" style={{ fontSize: "clamp(1.9rem, 4vw, 2.9rem)", fontWeight: 780, letterSpacing: "-0.02em", marginBottom: "var(--s3)" }}>
            One result. Deliver it through supported channels.
          </h2>
          <p className="dark-ink-soft body-lg" style={{ maxWidth: "56ch", margin: "0 auto var(--s5)" }}>
            The Agent Inbox works out of the box. Email, Telegram, Slack, webhooks, and other
            configured connectors can deliver the same output without moving execution to our website.
          </p>
          <div className="deliver-radial">
            <svg viewBox="0 0 800 340" preserveAspectRatio="none" aria-hidden="true">
              <path d="M400 175 C300 125 200 95 120 85" /><path d="M400 175 C320 95 260 65 200 45" />
              <path d="M400 175 C500 125 600 95 680 85" /><path d="M400 175 C480 95 560 65 620 45" />
              <path d="M400 175 C400 245 400 285 400 305" />
            </svg>
            <div className="deliver-core">✓ Agent output ready</div>
            <div className="deliver-node" style={{ top: "60px", left: "8%" }}><span /> Telegram</div>
            <div className="deliver-node" style={{ top: "18px", left: "22%" }}><span /> Email</div>
            <div className="deliver-node" style={{ top: "60px", right: "8%" }}><span /> Slack</div>
            <div className="deliver-node" style={{ top: "18px", right: "22%" }}><span /> WhatsApp</div>
            <div className="deliver-node deliver-node--inbox" style={{ bottom: "6px", left: "50%" }}><span /> Agent Inbox</div>
          </div>
        </div>
      </section>

      {/* ════════════ 3.7 · WHY NOT A RAW FRAMEWORK (the contrast) ════════════ */}
      <section style={{ background: "var(--canvas)", borderTop: "1px solid var(--line)" }}>
        <div className="container" style={{ paddingTop: "var(--s9)", paddingBottom: "var(--s9)" }}>
          <p className="micro" style={{ marginBottom: "var(--s3)" }}>Why Krelvan</p>
          <h2 className="display h1" style={{ marginBottom: "var(--s3)", maxWidth: "24ch" }}>
            A framework gives you parts. Krelvan gives you the <span style={{ color: "var(--brand)" }}>whole working system</span>.
          </h2>
          <p className="body-lg soft" style={{ maxWidth: "60ch", marginBottom: "var(--s7)" }}>
            You can wire these layers yourself in a raw agent framework. Krelvan provides an integrated,
            inspectable implementation you can run and evaluate.
          </p>
          <div className="contrast-grid">
            {[
              { a: "Write the graph, the runner, the retries", b: "Describe a goal — the agent is built and run for you" },
              { a: "Wire up delivery to every channel yourself", b: "Output reaches you in the Inbox, email, Telegram, Slack — built in" },
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

      {/* ════════════ 4 · DEPTH GRID — surface ALL the real capability, ranked ════════════ */}
      {/* Council: don't undersell. A flat even grid reads as junior. Rank by what survives a
          skeptic — Tier-1 (the wedge) gets the lead, then real substance, then table-stakes terse. */}
      <section style={{ background: "var(--canvas)", borderTop: "1px solid var(--line)" }}>
        <div className="container" style={{ paddingTop: "var(--s9)", paddingBottom: "var(--s9)" }}>
          <p className="micro" style={{ marginBottom: "var(--s3)" }}>Not a wrapper</p>
          <h2 className="display h1" style={{ marginBottom: "var(--s3)", maxWidth: "24ch" }}>
            The infrastructure <span style={{ color: "var(--brand)" }}>underneath</span>.
          </h2>
          <p className="body-lg soft" style={{ maxWidth: "60ch", marginBottom: "var(--s7)" }}>
            Full run history, failure diagnosis, human control, and process isolation are built into
            the current system, so you can focus more of your work on domain logic.
          </p>
          <div className="depth-grid">
            {[
              { k: "The canvas IS the runtime", v: "Every step is a real recorded event. The canvas, run history and status views are all pure reads of it — so you can scrub back through any run, step by step, and what you see is exactly what executed.", href: "/faq", cta: "Read how it works", lead: true },
              { k: "Failure diagnosis + retry", v: "When a run fails, Krelvan reads its full history to diagnose why, drafts a corrected agent, and re-runs it — and the repair attempt is recorded too, pass or fail.", href: "/faq", cta: "Read the details", lead: true },
              { k: "Build from plain English", v: "Describe an outcome; get a validated, typed agent graph. The model is a compiler into a manifest the kernel runs — it never executes free-form code.", href: "/faq", cta: "See how building works" },
              { k: "Human-in-the-loop gate", v: "Dial autonomy per step — suggest, act-with-veto, full. It pauses before the steps you gate and shows the exact action, not a summary.", href: "/faq", cta: "Read about approvals" },
              { k: "Real OS-process sandbox", v: "Untrusted TS plugins run with restricted process permissions, brokered network access, and secrets injected only at the destination.", href: "/marketplace", cta: "Inspect capabilities" },
              { k: "Memory + RAG, offline-capable", v: "Episodic, semantic and trust-aware memory with provenance. Local embeddings can run through Ollama.", href: "/marketplace?entry=personal-advisor", cta: "Inspect the advisor" },
              { k: "7 providers, swappable", v: "Anthropic, OpenAI, Gemini, Groq, Mistral, any OpenAI-compatible endpoint, or Ollama locally. Configure the provider in your installation.", href: "/faq", cta: "Compare providers" },
              { k: "Scheduled + self-hosted", v: "Cron and interval schedules run agents unattended. The downloaded application includes its own admin setup, sessions, and request protection.", href: "/faq", cta: "Read self-hosting guidance" },
            ].map(c => (
              <Link key={c.k} href={c.href} className={`card depth-card${c.lead ? " depth-card--lead" : ""}`}>
                <div className="depth-card__title">
                  <span aria-hidden="true" className="depth-card__check">
                    <svg viewBox="0 0 16 16" width="15" height="15" fill="none"><path d="M3.5 8.5l3 3 6-6.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"/></svg>
                  </span>
                  {c.k}
                </div>
                <p className="small soft depth-card__body">{c.v}</p>
                <span className="small depth-card__cta">{c.cta} →</span>
              </Link>
            ))}
          </div>
        </div>
      </section>

      {/* ════════════ 5 · WHAT THIS IS / ISN'T (honest scoping — cynic catnip) ════════════ */}
      <section style={{ background: "var(--surface)", borderTop: "1px solid var(--line)" }}>
        <div className="container" style={{ paddingTop: "var(--s9)", paddingBottom: "var(--s9)" }}>
          <p className="micro" style={{ marginBottom: "var(--s3)" }}>Straight about the edges</p>
          <h2 className="display h1" style={{ marginBottom: "var(--s6)", maxWidth: "24ch" }}>
            What this is — and what it isn&apos;t.
          </h2>
          <div className="isisnt">
            <div className="isisnt__col isisnt__col--is">
              <div className="isisnt__head">What it is</div>
              <ul>
                <li>A self-hostable, open-source platform for real agents that research, draft, and act across your tools — describe an outcome, get a working multi-agent system.</li>
                <li>Output that reaches you where you live: the Agent Inbox out of the box, or delivered to email, Telegram, Slack, and more. Runs on any LLM provider, or fully local.</li>
                <li>Infrastructure you own: your data, your machine, an auditable record of every run. The cloud is optional, not the product.</li>
              </ul>
            </div>
            <div className="isisnt__col isisnt__col--isnt">
              <div className="isisnt__head">What it isn&apos;t</div>
              <ul>
                <li>Not a hosted SaaS with an open-source husk — the whole thing runs on your box.</li>
                <li>Not magic. An agent can still be wrong; that&apos;s why the risky steps pause for your approval and every run keeps an auditable record you can replay.</li>
                <li>Not finished. This is an early release — we mark exactly which parts are battle-tested so you can judge the rest for yourself.</li>
              </ul>
            </div>
          </div>
        </div>
      </section>

      {/* ════════════ 6 · FINAL CTA — three time-boxed lanes (verify / clone / star) ════════════ */}
      <section className="hero-dark" style={{ paddingTop: "var(--s9)", paddingBottom: "var(--s9)" }}>
        <div className="container" style={{ position: "relative", zIndex: 1, textAlign: "center" }}>
          <p className="micro" style={{ marginBottom: "var(--s4)" }}>Ready when you are</p>
          <h2 className="dark-ink display" style={{ marginBottom: "var(--s4)" }}>
            Start <span className="dark-teal">building</span>.
          </h2>
          <p className="dark-ink-soft body-lg" style={{ maxWidth: "52ch", margin: "0 auto var(--s7)" }}>
            Open source, self-hosted, yours to keep. Pick a lane — each sized to how much
            you want to commit right now.
          </p>
          <div className="cta-lanes">
            <div className="cta-lane">
              <div className="cta-lane__time mono">First run</div>
              <div className="cta-lane__title">Clone &amp; run</div>
              <p className="cta-lane__desc">One command boots the API + web UI on <span className="mono">localhost:3100</span>, or <span className="mono">docker compose up</span>. Describe a goal and get a real agent.</p>
              <InstallCommand />
            </div>
            <div className="cta-lane">
              <div className="cta-lane__time mono">Source</div>
              <div className="cta-lane__title">Read the source</div>
              <p className="cta-lane__desc">It&apos;s all open — the builder, the marketplace, the capabilities. Star it if it&apos;s your kind of thing.</p>
              <a href="https://github.com/sreenathmmenon/krelvan" className="btn btn-dark-ghost btn-sm" style={{ display: "inline-flex", alignItems: "center", gap: "var(--s2)" }}>
                <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M8 1.6a6.4 6.4 0 0 0-2 12.5c.3.06.43-.14.43-.3v-1.1c-1.8.4-2.2-.85-2.2-.85-.3-.75-.72-.95-.72-.95-.6-.4.04-.4.04-.4.65.05 1 .67 1 .67.58 1 1.5.7 1.9.55.06-.43.23-.7.42-.87-1.45-.16-2.97-.72-2.97-3.2 0-.7.25-1.3.66-1.74-.07-.16-.29-.82.06-1.7 0 0 .54-.18 1.78.66a6.1 6.1 0 0 1 3.24 0c1.24-.84 1.78-.66 1.78-.66.35.88.13 1.54.06 1.7.41.44.66 1.04.66 1.74 0 2.49-1.52 3.04-2.97 3.2.23.2.44.6.44 1.2v1.78c0 .17.12.37.44.3A6.4 6.4 0 0 0 8 1.6z"/></svg>
                Star on GitHub
              </a>
            </div>
            <div className="cta-lane">
              <div className="cta-lane__time mono">Read-only</div>
              <div className="cta-lane__title">Inspect a real agent</div>
              <p className="cta-lane__desc">Open a real registry manifest before deciding whether to install it.</p>
              <Link href="/marketplace?entry=research-analyst" className="btn btn-dark-ghost btn-sm">Inspect it →</Link>
            </div>
          </div>
        </div>
      </section>

    </div>
  );
}
