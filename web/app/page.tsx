"use client";
import { useState, useEffect, useCallback, useRef, Fragment } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  listAgents, listRuns, buildAgent, startRun, autoSummarizeRuns, getStatus, timeAgo,
  type AgentRecord, type RunRecord, type BuildResult, type ManifestNode, type ManifestEdge,
} from "../lib/api";
import {
  BuildPreviewModal, MiniGraph, HeroAnimation, EXAMPLES, BUILD_STAGES,
} from "./_builder";
import { loadRegistry, type CatalogEntry } from "../lib/registry";
import { glyphFor, UI } from "../lib/glyphs";
import { verifyBundle, type ProofBundle, type VerifyResult } from "../lib/verify-bundle";

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

// The build-magic panels the hero rotates through — a plain-English sentence, then the
// real agent SYSTEM it compiles into. This IS the headline made visible.
const HERO_BUILDS: { prompt: string; nodes: ManifestNode[]; edges: ManifestEdge[] }[] = [
  {
    prompt: "Search the web for the latest AI news and summarise the top developments.",
    nodes: [
      { id: "search", role: "search the web", autonomy: "auto", capabilities: [{ name: "web_search", sideEffect: "read", budgetCents: 1 }] },
      { id: "reason", role: "reason over findings", autonomy: "auto", capabilities: [{ name: "think", sideEffect: "none", budgetCents: 3 }] },
      { id: "digest", role: "write the digest", autonomy: "auto", capabilities: [{ name: "compose", sideEffect: "none", budgetCents: 2 }] },
    ] as ManifestNode[],
    edges: [{ from: "search", to: "reason" }, { from: "reason", to: "digest" }] as ManifestEdge[],
  },
  {
    prompt: "Answer customer questions from my docs, and escalate the hard ones to a human.",
    nodes: [
      { id: "retrieve", role: "retrieve from docs", autonomy: "auto", capabilities: [{ name: "rag.search", sideEffect: "read", budgetCents: 1 }] },
      { id: "answer", role: "draft the answer", autonomy: "auto", capabilities: [{ name: "compose", sideEffect: "none", budgetCents: 2 }] },
      { id: "escalate", role: "escalate to a human", autonomy: "suggest", capabilities: [{ name: "slack_send", sideEffect: "message-human", budgetCents: 1 }] },
    ] as ManifestNode[],
    edges: [{ from: "retrieve", to: "answer" }, { from: "answer", to: "escalate" }] as ManifestEdge[],
  },
  {
    prompt: "Watch this page daily and alert me the moment the price changes.",
    nodes: [
      { id: "fetch", role: "fetch the page", autonomy: "auto", capabilities: [{ name: "http_get", sideEffect: "read", budgetCents: 1 }] },
      { id: "detect", role: "detect a change", autonomy: "auto", capabilities: [{ name: "think", sideEffect: "none", budgetCents: 2 }] },
      { id: "alert", role: "alert me", autonomy: "auto", capabilities: [{ name: "notify_webhook", sideEffect: "message-human", budgetCents: 1 }] },
    ] as ManifestNode[],
    edges: [{ from: "fetch", to: "detect" }, { from: "detect", to: "alert" }] as ManifestEdge[],
  },
];

function HeroBuildPanel() {
  const [scene, setScene] = useState(0);
  const [typed, setTyped] = useState("");
  const [compiled, setCompiled] = useState(false);
  const build = HERO_BUILDS[scene]!;

  useEffect(() => {
    // reduced-motion: show the finished state, no typing loop.
    if (typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      setTyped(build.prompt); setCompiled(true); return;
    }
    setTyped(""); setCompiled(false);
    let i = 0; const full = build.prompt;
    const typer = setInterval(() => {
      i += 2; setTyped(full.slice(0, i));
      if (i >= full.length) { clearInterval(typer); setTimeout(() => setCompiled(true), 450); }
    }, 34);
    const rotate = setTimeout(() => setScene(s => (s + 1) % HERO_BUILDS.length), 6800);
    return () => { clearInterval(typer); clearTimeout(rotate); };
  }, [scene, build.prompt]);

  return (
    <div className="hero-build" aria-hidden="true">
      <div className="hero-build__bar">
        <span className="hero-build__dots" aria-hidden="true"><i /><i /><i /></span>
        <span className="hero-build__title mono">describe your agent</span>
      </div>
      <div className="hero-build__body">
        <div className="hero-build__prompt">
          <span className="hero-build__caret-line">{typed}<span className="hero-build__caret" /></span>
        </div>
        <div className={`hero-build__result${compiled ? " is-in" : ""}`}>
          <div className="hero-build__resulthead mono">
            <span className="hero-build__ok" aria-hidden="true">
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M3.5 8.5l3 3 6-6.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
            </span>
            compiled · {build.nodes.length} nodes, {build.edges.length} edges
          </div>
          <MiniGraph nodes={build.nodes} edges={build.edges} entry={build.nodes[0]!.id} variant="dark" maxHeight={150} />
        </div>
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
        <Link href="/capabilities?install=&kind=mcp" className="connector-chip connector-chip--more mono">+13 more →</Link>
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
    void fetch("https://api.github.com/repos/sreenathmmenon/krelvan")
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d && typeof d.stargazers_count === "number" && d.stargazers_count > 0) setStars(d.stargazers_count); })
      .catch(() => {});
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
    { n: c ? String(c.total) : "—", l: "capabilities", href: "/capabilities" },
    { n: c ? String(c.agents) : "—", l: "ready-to-run agents", href: "/capabilities?kind=template" },
    { n: c ? String(c.mcp) : "—", l: "MCP connectors", href: "/capabilities?kind=mcp" },
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
        proofs verify offline
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
          No hosted black box. Every entry is an inspectable file in a public registry. Install any
          in one click and watch it run — every step signed, the risky ones pausing for your approval.
        </p>
        {/* The depth numbers live in the hero stat strip above the fold; this section is
            about BROWSING, so it leads with the real integrations + the example agents
            instead of repeating the same four counts verbatim (council: earn the space). */}
        {/* real integrations — only connectors that actually ship in the registry */}
        <ConnectorStrip />
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
        {copied
          ? <><svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true" style={{ marginRight: 4, verticalAlign: "-1px" }}><path d={UI.check} stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></svg>Copied</>
          : "Copy"}
      </button>
    </div>
  );
}

// ── Live in-browser verifier — the viral hook ──────────────────────────────────
// Fetch the genuine signed sample bundle (/sample-run.krproof.json, Ed25519, 7 events) and
// verify it client-side with Web Crypto (web/lib/verify-bundle.ts) — the same checks the CLI
// runs. The "tamper" toggle flips one byte of a payload and re-verifies LIVE, so a skeptic
// watches ✓ CONSISTENT flip to ✗ REJECTED in their own browser (open devtools — it's genuinely
// computing SHA-256 + Ed25519). Not a re-enactment; the real check. Shared by the hero + band.
const VERIFY_CMD = "npx krelvan verify sample-run.krproof.json";
const TWEET = "Krelvan agent runs are Ed25519-signed — you can `npx krelvan verify` them offline, zero deps. Change one byte and it rejects. AI agents you can actually audit.";
const SHARE_URL = "https://krelvan.com";
const TWEET_HREF = `https://twitter.com/intent/tweet?text=${encodeURIComponent(TWEET)}&url=${encodeURIComponent(SHARE_URL)}`;

function useLiveVerify() {
  const [bundle, setBundle] = useState<ProofBundle | null>(null);
  const [tampered, setTampered] = useState(false);
  const [result, setResult] = useState<VerifyResult | null>(null);
  const [verifying, setVerifying] = useState(false);
  useEffect(() => {
    void fetch("/sample-run.krproof.json").then(r => r.json()).then((b: ProofBundle) => setBundle(b)).catch(() => {});
  }, []);
  useEffect(() => {
    if (!bundle) return;
    let cancelled = false;
    setVerifying(true);
    const candidate: ProofBundle = JSON.parse(JSON.stringify(bundle));
    if (tampered) {
      const target = candidate.events.find(e => e.payload && typeof e.payload === "object") ?? candidate.events[1];
      target.payload = { ...(target.payload as object), tampered: "one byte changed" };
    }
    void verifyBundle(candidate).then(r => { if (!cancelled) { setResult(r); setVerifying(false); } });
    return () => { cancelled = true; };
  }, [bundle, tampered]);
  return { tampered, setTampered, result, verifying };
}

// The live terminal + tamper toggle. `compact` shortens the title for the narrow hero panel
// so the tamper pill always fits on one line.
function VerifyTerminal({ tampered, setTampered, result, verifying, idleNudge, compact }: {
  tampered: boolean; setTampered: (v: boolean) => void; result: VerifyResult | null; verifying: boolean; idleNudge?: boolean; compact?: boolean;
}) {
  const pass = result?.verdict === "CONSISTENT";
  return (
    <div className={`proveit__term proveit__term--live${pass ? " is-pass" : result ? " is-fail" : ""}`} aria-live="polite">
      <div className="proveit__termbar">
        <span aria-hidden="true" /><span aria-hidden="true" /><span aria-hidden="true" />
        <span className="proveit__termtitle mono">{compact ? "verify · browser" : "krelvan verify · in your browser"}</span>
        <label className={`proveit__tamper${idleNudge && !tampered ? " is-nudge" : ""}`}>
          <input type="checkbox" checked={tampered} onChange={e => setTampered(e.target.checked)} />
          <span>Tamper with one byte</span>
        </label>
      </div>
      <div className="proveit__termbody">
        <div className="proveit__cmd">
          <span className="proveit__dollar">$</span>
          <code>{VERIFY_CMD}{tampered ? "   # one byte changed" : ""}</code>
        </div>
        {!result ? (
          <pre className="proveit__out">{verifying ? "  verifying…" : "  loading sample run…"}</pre>
        ) : (
          <pre className="proveit__out">{`  content addresses : `}<span className={result.hashes.failed === 0 ? "proveit__ok" : "proveit__bad"}>{result.hashes.failed === 0 ? `all ${result.hashes.checked} match` : `${result.hashes.failed} mismatch`}</span>{`
  signatures        : `}<span className={result.signatures.failed === 0 && result.signatures.allSigned ? "proveit__ok" : "proveit__bad"}>{result.signatures.failed === 0 && result.signatures.allSigned ? `all ${result.signatures.checked} valid` : `${result.signatures.failed} invalid`}</span>{`
  run boundaries    : `}<span className={result.boundaries.startsAtRunStarted && result.boundaries.endsTerminal ? "proveit__ok" : "proveit__bad"}>{result.boundaries.startsAtRunStarted && result.boundaries.endsTerminal ? "RunStarted → terminal" : "broken"}</span>{`

`}{pass
  ? <><span className="proveit__ok">{`✓ CONSISTENT`}</span>{` — every event authentic and unaltered.
  (pin `}<span className="dim">--key</span>{` to also prove which instance signed it.)`}</>
  : <><span className="proveit__bad">{`✗ REJECTED`}</span>{` — the run was altered. Do not trust it.`}</>}</pre>
        )}
      </div>
    </div>
  );
}

// Hero right panel: the live verifier (the proof, in the hero, above the fold). Falls back to
// a real completed-run artifact when one exists.
function HeroVerifyPanel() {
  const v = useLiveVerify();
  // One-time auto-demo so a first-time visitor SEES the wedge without interacting:
  // once the real run verifies CONSISTENT, flip a byte (→ REJECTED, red), hold, flip
  // back. Runs once, skips on reduced-motion, then the visitor can drive it themselves.
  const played = useRef(false);
  const firstConsistent = v.result?.verdict === "CONSISTENT";
  useEffect(() => {
    if (played.current || !firstConsistent) return;
    if (typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    played.current = true; // latch BEFORE scheduling so result-driven re-renders never re-enter or tear this down
    setTimeout(() => v.setTampered(true), 1400);
    setTimeout(() => v.setTampered(false), 1400 + 2200);
    // intentionally no cleanup: this one-shot demo must complete even as v.result changes
  }, [firstConsistent]); // eslint-disable-line react-hooks/exhaustive-deps
  return <VerifyTerminal {...v} idleNudge compact />;
}

function ProveItBand() {
  const v = useLiveVerify();
  const [copied, setCopied] = useState(false);
  const copy = useCallback(() => {
    void navigator.clipboard.writeText(VERIFY_CMD).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1600); });
  }, []);
  return (
    <section className="proveit" aria-labelledby="proveit-h">
      <div className="container proveit__grid">
        <div className="proveit__lede">
          <p className="micro" style={{ marginBottom: "var(--s2)" }}>You shouldn&apos;t trust this page</p>
          <h2 id="proveit-h" className="display h1" style={{ marginBottom: "var(--s3)" }}>
            Don&apos;t trust the demo. <span className="dark-teal" style={{ fontWeight: 800 }}>Verify it.</span>
          </h2>
          <p className="body-lg soft" style={{ maxWidth: "48ch", marginBottom: "var(--s5)" }}>
            This is a <strong>real signed run</strong> from a real agent. The verifier on the right
            is running in <em>your</em> browser right now — recomputing every SHA-256 hash and checking
            every Ed25519 signature, no server, no trust. Flip the tamper switch and watch it reject.
          </p>
          <div style={{ display: "flex", gap: "var(--s3)", flexWrap: "wrap", alignItems: "center" }}>
            <a href="/sample-run.krproof.json" download className="btn btn-dark-primary">
              Download this run ↓
            </a>
            <a href={TWEET_HREF} target="_blank" rel="noopener noreferrer" className="btn btn-dark-ghost">
              Share this on X →
            </a>
          </div>
          <p className="dark-ink-muted small" style={{ marginTop: "var(--s5)", maxWidth: "48ch", lineHeight: 1.6 }}>
            Then run it for real: <code className="mono" style={{ color: "var(--dark-ink-soft)" }}>{VERIFY_CMD}</code>{" "}
            <button type="button" onClick={copy} className="proveit__inlinecopy">{copied ? "copied" : "copy"}</button>.
            The verifier is open and hardened against forgery — signature-stripping, algorithm-downgrade,
            chain-break. Don&apos;t take our word for it:{" "}
            <a href="https://github.com/sreenathmmenon/krelvan/blob/main/bin/krelvan-verify.mjs" className="dark-teal" style={{ textDecoration: "underline" }}>read it before you believe it</a>.
          </p>
        </div>
        <VerifyTerminal {...v} />
      </div>
    </section>
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
            <span className="dark-verify-seal__mark" aria-hidden="true">
              <svg width="11" height="11" viewBox="0 0 16 16" fill="none"><path d={UI.check} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
            </span>
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

function scrollToProveIt() {
  document.getElementById("proveit-h")?.closest("section")?.scrollIntoView({ behavior: "smooth", block: "start" });
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
  const fetchingSummaries = useRef<Set<string>>(new Set());

  // Track consecutive fetch failures so a logged-out visitor (every call 401s) doesn't
  // poll a failing endpoint forever on the public landing page.
  const pollFailures = useRef(0);

  const reload = useCallback(async () => {
    try {
      const [a, r] = await Promise.all([listAgents(), listRuns()]);
      setAgents(a);
      setRuns(r);
      pollFailures.current = 0;
    } catch { pollFailures.current += 1; }
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
    // Poll for live agents/runs, but give up after 3 consecutive failures (a logged-out
    // visitor on the marketing page) so we don't hammer a 401-ing endpoint forever.
    const t = setInterval(() => {
      if (pollFailures.current >= 3) { clearInterval(t); return; }
      void reload();
    }, 3000);
    return () => clearInterval(t);
  }, [reload]);

  // Model readiness — drives the build gate + the "Model connected" pill.
  useEffect(() => { void getStatus().then(s => setModelReady(s.hasLlm)).catch(() => setModelReady(null)); }, []);

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
              <p className="micro" style={{ marginBottom: "var(--s4)" }}>Open-source · self-hosted</p>
              <h1
                className="display dark-ink"
                style={{ fontSize: "clamp(38px, 4.8vw, 58px)", lineHeight: 1.06, fontWeight: 600, letterSpacing: "-0.03em", marginBottom: "var(--s5)", textWrap: "balance", maxWidth: "18ch" }}
              >
                Write a sentence. <span className="dark-teal" style={{ fontWeight: 800 }}>Get a working agent system.</span>
              </h1>
              <p className="dark-ink-soft body-lg" style={{ maxWidth: "52ch", marginBottom: "var(--s5)" }}>
                Krelvan turns plain English into real agents that act across your tools and run
                on your schedule — then an open marketplace to extend what exists, publish what
                you make, and sell what works.
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
              <div className="hero-trustline">
                <span className="hero-trustline__item">Open-source</span>
                <span className="hero-trustline__sep" aria-hidden="true">·</span>
                <span className="hero-trustline__item">Self-hosted</span>
                <span className="hero-trustline__sep" aria-hidden="true">·</span>
                <span className="hero-trustline__item">7 LLM providers</span>
                <span className="hero-trustline__sep" aria-hidden="true">·</span>
                <span className="hero-trustline__item">Open marketplace</span>
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
          leads, so the page shows what you can build before it argues about proof. */}
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
              <div className="build-box__head" style={{ justifyContent: "space-between" }}>
                <span style={{ display: "inline-flex", alignItems: "center", gap: "var(--s2)" }}>
                  <span className="build-box__badge" aria-hidden="true">
                    <svg viewBox="0 0 16 16" width="14" height="14" fill="none">
                      <path d="M8 1.6l1.7 4.7L14.4 8l-4.7 1.7L8 14.4l-1.7-4.7L1.6 8l4.7-1.7L8 1.6z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
                    </svg>
                  </span>
                  <span className="micro" style={{ color: "var(--ink-soft)" }}>Describe your agent</span>
                </span>
                {modelReady === true && (
                  <span className="model-pill model-pill--on" title="A model is connected — you can build agents">
                    <span className="model-pill__dot" /> Model connected
                  </span>
                )}
                {modelReady === false && (
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
                  {timeAgo(latestCompleted.createdAt)} · <span className="mono" style={{ color: "var(--brand)", fontWeight: 600 }}>signed · replayable</span>
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
          of the canvas — the signed graph that maps 1:1 to what executed. */}
      <section style={{ background: "var(--surface)", borderTop: "1px solid var(--line)" }}>
        <div className="container" style={{ paddingTop: "var(--s9)", paddingBottom: "var(--s9)" }}>
          <p className="micro" style={{ marginBottom: "var(--s3)" }}>The canvas is the runtime</p>
          <h2 className="h1" style={{ marginBottom: "var(--s3)", maxWidth: "20ch" }}>
            What you see <span style={{ color: "var(--brand)" }}>is what runs.</span>
          </h2>
          <p className="body-lg soft" style={{ maxWidth: "56ch", marginBottom: "var(--s6)" }}>
            Every node is a real step, every edge a real branch, and each run replays over the
            same signed ledger — so the graph is not a diagram of the agent, it is the agent.
          </p>
          <figure style={{ margin: 0, borderRadius: "var(--r-xl, 16px)", overflow: "hidden", border: "1px solid var(--line)", boxShadow: "var(--shadow-lg)", background: "var(--graph-bg)" }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/product-canvas.png" alt="The Krelvan canvas showing a 12-node support agent: triage, retrieve, judge with a revise loop, route, send, escalate — each step signed into the ledger."
              width={1400} height={640} loading="lazy" style={{ display: "block", width: "100%", height: "auto" }} />
          </figure>
        </div>
      </section>

      {/* ════════════ 3.5 · EXAMPLE-AGENT GALLERY (the marketplace — breadth) ════════════ */}
      <ExampleGallery />

      {/* ════════════ 3.6 · ONE quiet proof beat (moved down from #2) ════════════ */}
      {/* After a visitor has seen what they can BUILD and the marketplace they can EXTEND,
          this is where the reproduce-it-yourself band earns its place — as one supporting
          beat, not the second thing on the page. */}
      <ProveItBand />

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
            The hard parts are solved — signed audit, failure diagnosis, human control, a real sandbox —
            so you build the domain logic and ship agentic solutions in days, not months.
          </p>
          <div className="depth-grid">
            {[
              { k: "The ledger IS the runtime", v: "Every step → an append-only, content-addressed, Ed25519-signed log. The canvas, audit trail and cost meter are pure reads of it — so you can scrub back through any run, step by step, and what you see is structurally what executed.", href: "/runs", cta: "Replay a signed run", lead: true },
              { k: "Failure diagnosis + retry", v: "When a run fails, Krelvan reads the ledger to diagnose why, drafts a corrected agent, and re-runs it — and the repair attempt is itself signed in, pass or fail.", href: "/runs", cta: "Explain a run", lead: true },
              { k: "Build from plain English", v: "Describe an outcome; get a validated, typed, signed agent graph. The model is a compiler into a manifest the kernel runs — it never executes free-form code.", href: "/dashboard", cta: "Build an agent" },
              { k: "Human-in-the-loop gate", v: "Dial autonomy per step — suggest, act-with-veto, full. It pauses before the steps you gate and shows the exact action, not a summary.", href: "/approvals", cta: "Open approvals" },
              { k: "Real OS-process sandbox", v: "Untrusted TS plugins under node --permission, SSRF-guarded brokered egress, secrets injected only at the destination. Adversarially tested.", href: "/capabilities", cta: "Browse capabilities" },
              { k: "Memory + RAG, offline-capable", v: "Episodic, semantic and trust-aware memory with provenance. rag.ingest / rag.search with local embeddings via Ollama — no key, no network.", href: "/capabilities?install=personal-advisor", cta: "Try the advisor" },
              { k: "7 providers, swappable", v: "Anthropic, OpenAI, Gemini, Groq, Mistral, any OpenAI-compatible — or Ollama fully local, no key, no network. Switch per agent.", href: "/secrets#model", cta: "Connect a model" },
              { k: "Scheduled + self-hosted", v: "Cron and interval schedules run agents unattended. Self-hosted auth — scrypt, sessions, CSRF — so an internet-facing box stays yours.", href: "/schedules", cta: "See schedules" },
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
                <li>A self-hostable, open-source agent platform whose runs are Ed25519-signed and offline-verifiable.</li>
                <li>A real proof core — the ledger, the signing, the export, and <code className="mono">npx krelvan verify</code> are the load-bearing, adversarially-tested parts.</li>
                <li>Infrastructure you own: your keys, your data, your machine. The cloud is optional, not the product.</li>
              </ul>
            </div>
            <div className="isisnt__col isisnt__col--isnt">
              <div className="isisnt__head">What it isn&apos;t</div>
              <ul>
                <li>Not a hosted SaaS with an open-source husk — the whole thing runs on your box.</li>
                <li>Not magic. An agent can still be wrong; that&apos;s why every step is signed, gated, and replayable.</li>
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
              <div className="cta-lane__time mono">~60 sec</div>
              <div className="cta-lane__title">Clone &amp; run</div>
              <p className="cta-lane__desc">One command boots the API + web UI on <span className="mono">localhost:3100</span>, or <span className="mono">docker compose up</span>. Describe a goal and get a real agent.</p>
              <InstallCommand />
            </div>
            <div className="cta-lane">
              <div className="cta-lane__time mono">~3 sec</div>
              <div className="cta-lane__title">Read the source</div>
              <p className="cta-lane__desc">It&apos;s all open — the builder, the marketplace, the capabilities. Star it if it&apos;s your kind of thing.</p>
              <a href="https://github.com/sreenathmmenon/krelvan" className="btn btn-dark-ghost btn-sm" style={{ display: "inline-flex", alignItems: "center", gap: "var(--s2)" }}>
                <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M8 1.6a6.4 6.4 0 0 0-2 12.5c.3.06.43-.14.43-.3v-1.1c-1.8.4-2.2-.85-2.2-.85-.3-.75-.72-.95-.72-.95-.6-.4.04-.4.04-.4.65.05 1 .67 1 .67.58 1 1.5.7 1.9.55.06-.43.23-.7.42-.87-1.45-.16-2.97-.72-2.97-3.2 0-.7.25-1.3.66-1.74-.07-.16-.29-.82.06-1.7 0 0 .54-.18 1.78.66a6.1 6.1 0 0 1 3.24 0c1.24-.84 1.78-.66 1.78-.66.35.88.13 1.54.06 1.7.41.44.66 1.04.66 1.74 0 2.49-1.52 3.04-2.97 3.2.23.2.44.6.44 1.2v1.78c0 .17.12.37.44.3A6.4 6.4 0 0 0 8 1.6z"/></svg>
                Star on GitHub
              </a>
            </div>
            <div className="cta-lane">
              <div className="cta-lane__time mono">~15 sec</div>
              <div className="cta-lane__title">See a real run</div>
              <p className="cta-lane__desc">Download a sample run and re-check it offline — no account, nothing to set up.</p>
              <button type="button" className="btn btn-dark-ghost btn-sm" onClick={scrollToProveIt}>See it →</button>
            </div>
          </div>
        </div>
      </section>

    </div>
  );
}
