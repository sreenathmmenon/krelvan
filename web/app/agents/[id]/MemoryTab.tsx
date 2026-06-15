"use client";

import { useState, useEffect, useCallback } from "react";
import {
  getAgentMemory, clearAgentMemory, timeAgo,
  type AgentMemory, type SemanticFact, type Episode, type Provenance, type Soul,
} from "../../../lib/api";

// ── Teal geometric glyphs (homepage / CapGlyph house style) ─────────────────────
// All UI icons are inline SVG in the brand-teal geometric style — never emoji or
// unicode dingbats. 16×16 viewBox, hairline strokes, optical balance.

type GlyphName = "beliefs" | "diary" | "memory" | "info" | "live";

function glyphPaths(name: GlyphName): React.ReactNode {
  switch (name) {
    case "beliefs": // facetted gem / fact — a known, settled thing
      return (
        <>
          <path d="M8 2.2l4.6 3.1L8 13.8 3.4 5.3 8 2.2z" stroke="var(--brand)" strokeWidth="1.2" fill="none" strokeLinejoin="round" />
          <path d="M3.4 5.3h9.2M8 2.2v11.6" stroke="var(--brand)" strokeWidth="1" fill="none" strokeLinecap="round" />
        </>
      );
    case "diary": // dated note / journal page with ruled lines
      return (
        <>
          <rect x="3" y="2.6" width="10" height="10.8" rx="1.2" stroke="var(--brand)" strokeWidth="1.2" fill="none" />
          <path d="M5.4 5.6h5.2M5.4 8h5.2M5.4 10.4h3.2" stroke="var(--brand)" strokeWidth="1.1" fill="none" strokeLinecap="round" />
        </>
      );
    case "memory": // concentric memory core — facts orbiting an identity
      return (
        <>
          <circle cx="8" cy="8" r="5.4" stroke="var(--brand)" strokeWidth="1.2" fill="none" />
          <circle cx="8" cy="8" r="2.4" stroke="var(--brand)" strokeWidth="1.2" fill="none" />
          <circle cx="8" cy="8" r="0.9" fill="var(--brand)" />
        </>
      );
    case "info": // info circle
      return (
        <>
          <circle cx="8" cy="8" r="5.6" stroke="var(--info)" strokeWidth="1.2" fill="none" />
          <circle cx="8" cy="5.2" r="0.85" fill="var(--info)" />
          <path d="M8 7.4v3.6" stroke="var(--info)" strokeWidth="1.4" fill="none" strokeLinecap="round" />
        </>
      );
    case "live": // pulse / heartbeat — used only for the alive treatment
      return (
        <path d="M2.4 8h2.6l1.4-3.4 2.2 6 1.4-2.6h3.6" stroke="var(--live)" strokeWidth="1.4" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      );
  }
}

function Glyph({ name, size = 16 }: { name: GlyphName; size?: number }) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} fill="none" aria-hidden="true" style={{ display: "block", flexShrink: 0 }}>
      {glyphPaths(name)}
    </svg>
  );
}

// ── Trust model ───────────────────────────────────────────────────────────────

const TRUSTED: ReadonlySet<Provenance> = new Set<Provenance>(["owner", "tool-observed"]);

function isTrusted(p: Provenance): boolean {
  return TRUSTED.has(p);
}

const PROVENANCE_LABEL: Record<Provenance, string> = {
  "owner":         "owner",
  "tool-observed": "tool",
  "channel":       "channel",
  "agent":         "agent",
  "memory":        "memory",
};

const PROVENANCE_DESCRIPTION: Record<Provenance, string> = {
  "owner":         "Trusted: set directly by the agent owner.",
  "tool-observed": "Trusted: observed by the agent during tool execution.",
  "channel":       "Quarantined: arrived via an external channel message. Will not authorize consequential actions.",
  "agent":         "Quarantined: provided by another agent. Will not authorize consequential actions.",
  "memory":        "Quarantined: distilled from quarantined sources. Will not authorize consequential actions.",
};

function provStyle(p: Provenance): { borderLeft: string; background?: string } {
  if (isTrusted(p)) return { borderLeft: "3px solid var(--brand)" };
  return { borderLeft: "3px solid var(--danger)", background: "var(--danger-tint)" };
}

function ProvBadge({ provenance }: { provenance: Provenance }) {
  const trusted = isTrusted(provenance);
  return (
    <span
      className={`badge ${trusted ? "badge-done" : "badge-failed"}`}
      title={PROVENANCE_DESCRIPTION[provenance]}
      style={{ cursor: "help", fontFamily: "var(--font-mono)" }}
    >
      <span className="dot" aria-hidden="true" />
      {PROVENANCE_LABEL[provenance]}
    </span>
  );
}

// shared column template so the table header and rows stay perfectly aligned
const FACT_GRID = "minmax(160px, 200px) minmax(0, 1fr) 92px 52px 148px 84px";

// ── Section label — a micro eyebrow above each block ────────────────────────────

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="micro" style={{ marginBottom: "var(--s2)" }}>{children}</div>
  );
}

// ── Soul panel ────────────────────────────────────────────────────────────────

function SoulPanel({ soul }: { soul: Soul | null }) {
  if (!soul) {
    return (
      <div className="card" style={{ padding: "var(--s5)", borderLeft: "3px solid var(--brand)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "var(--s3)", marginBottom: "var(--s2)" }}>
          <span className="h3">Identity</span>
          <span className="badge badge-neutral">not set</span>
        </div>
        <p className="small soft" style={{ margin: 0, maxWidth: "60ch" }}>
          This agent has no identity yet. Give it an{" "}
          <code className="mono" style={{ background: "var(--surface-sunken)", padding: "var(--s1) var(--s2)", borderRadius: "var(--r-sm)" }}>identify</code>{" "}
          capability and its name, values, and standing instructions will appear here once it runs.
        </p>
      </div>
    );
  }

  const isBootstrap = soul.version === 0;

  return (
    <div className="card" style={{ padding: "var(--s5)", borderLeft: "3px solid var(--brand)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "var(--s3)", marginBottom: "var(--s5)", flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "var(--s3)" }}>
          <span className="h3">Identity</span>
          <span className={`badge ${isBootstrap ? "badge-neutral" : "badge-done"} mono`}>
            v{soul.version}{isBootstrap ? " · default" : ""}
          </span>
        </div>
      </div>

      <div style={{ marginBottom: "var(--s5)" }}>
        <SectionLabel>Name</SectionLabel>
        <div className="body-lg" style={{ color: "var(--ink)", fontWeight: 600, letterSpacing: "-0.01em" }}>{soul.name}</div>
      </div>

      <div className="mem-soul-grid" style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)", gap: "var(--s6)", alignItems: "start" }}>
        <div>
          <SectionLabel>Values</SectionLabel>
          {soul.values.length === 0
            ? <span className="small muted" style={{ fontStyle: "italic" }}>none set</span>
            : <ul style={{ margin: 0, paddingLeft: "var(--s5)", display: "flex", flexDirection: "column", gap: "var(--s2)" }}>
                {soul.values.map((v, i) => (
                  <li key={i} className="small" style={{ color: "var(--ink)", lineHeight: 1.55 }}>{v}</li>
                ))}
              </ul>
          }
        </div>

        <div>
          <SectionLabel>Standing instructions</SectionLabel>
          {soul.standingInstructions.length === 0
            ? <span className="small muted" style={{ fontStyle: "italic" }}>none set</span>
            : <ol style={{ margin: 0, paddingLeft: "var(--s5)", display: "flex", flexDirection: "column", gap: "var(--s2)" }}>
                {soul.standingInstructions.map((inst, i) => (
                  <li key={i} className="small" style={{ color: "var(--ink)", lineHeight: 1.55 }}>{inst}</li>
                ))}
              </ol>
          }
        </div>
      </div>
    </div>
  );
}

// ── Semantic facts ────────────────────────────────────────────────────────────

function FactRow({ fact, even }: { fact: SemanticFact; even: boolean }) {
  const ps = provStyle(fact.provenance);
  const derivedRunId = fact.derivedFrom[0];
  return (
    <div style={{
      display: "grid",
      gridTemplateColumns: FACT_GRID,
      gap: "var(--s3)",
      alignItems: "center",
      padding: "var(--s3) var(--s4)",
      borderBottom: "1px solid var(--line)",
      borderLeft: ps.borderLeft,
      background: ps.background ?? (even ? "var(--surface-hover)" : "var(--surface)"),
    }}>
      <span className="mono small" style={{ fontWeight: 600, color: "var(--ink)", wordBreak: "break-all" }}>
        {fact.key}
      </span>
      <span className="mono small text-truncate" style={{ color: "var(--ink-soft)" }}
        title={String(fact.value)}>
        {String(fact.value)}
      </span>
      <ProvBadge provenance={fact.provenance} />
      <span className="mono small" style={{ color: "var(--ink-muted)", textAlign: "center" }}
        title={`Version ${fact.version}`}>
        v{fact.version}
      </span>
      <span className="small" style={{ minWidth: 0 }}>
        {derivedRunId ? (
          <a href={`/runs/${derivedRunId}`} className="mono text-truncate" style={{ color: "var(--brand)", display: "block" }} title={derivedRunId}>
            {derivedRunId.slice(0, 14)}…
          </a>
        ) : <span className="muted">—</span>}
      </span>
      <span className="mono small muted" style={{ textAlign: "right" }}>{timeAgo(fact.ts)}</span>
    </div>
  );
}

function SemanticFactsPanel({ facts }: { facts: SemanticFact[] }) {
  const sorted = [...facts].sort((a, b) => b.ts - a.ts);
  const quarantined = facts.filter(f => !isTrusted(f.provenance)).length;

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "var(--s3)", marginBottom: "var(--s4)", flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: "var(--s3)" }}>
          <span className="h3">Beliefs</span>
          {facts.length > 0 && <span className="badge badge-neutral mono">{facts.length}</span>}
        </div>
        {quarantined > 0 && (
          <span className="small" style={{ color: "var(--ink-muted)" }}>
            <span className="mono" style={{ color: "var(--danger)" }}>{quarantined}</span> quarantined
          </span>
        )}
      </div>

      {facts.length === 0 ? (
        <div className="state-empty small">
          <Glyph name="beliefs" size={26} />
          <p className="h3" style={{ color: "var(--ink-soft)", margin: 0 }}>No beliefs yet</p>
          <p style={{ maxWidth: "44ch", margin: 0 }}>
            Facts the agent learns and keeps across runs land here. Add{" "}
            <code className="mono" style={{ background: "var(--surface-sunken)", padding: "var(--s1) var(--s2)", borderRadius: "var(--r-sm)" }}>remember</code>{" "}
            to a node to start building them.
          </p>
        </div>
      ) : (
        <div className="card mem-table-scroll" style={{ overflow: "hidden", padding: 0 }}>
          <div className="mem-table-inner">
            {/* table header */}
            <div style={{
              display: "grid", gridTemplateColumns: FACT_GRID,
              gap: "var(--s3)", padding: "var(--s2) var(--s4)",
              background: "var(--surface-sunken)", borderBottom: "1px solid var(--line)",
            }}>
              {["Key", "Value", "Trust", "Ver", "From run", "When"].map((h, i) => (
                <span key={h} className="micro" style={{ textAlign: i === 3 ? "center" : i === 5 ? "right" : "left" }}>{h}</span>
              ))}
            </div>
            {sorted.map((f, i) => <FactRow key={f.key} fact={f} even={i % 2 === 1} />)}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Episodic log ──────────────────────────────────────────────────────────────

function EpisodeRow({ ep, isLast }: { ep: Episode; isLast: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const truncated = ep.summary.length > 200;
  const display = expanded || !truncated ? ep.summary : ep.summary.slice(0, 200) + "…";
  const trusted = isTrusted(ep.provenance);
  const dotColor = trusted ? "var(--brand)" : "var(--danger)";
  return (
    <div style={{
      display: "flex", gap: "var(--s4)", padding: "var(--s4) var(--s5)",
      borderBottom: isLast ? "none" : "1px solid var(--line)", alignItems: "flex-start",
    }}>
      {/* timeline rail */}
      <div aria-hidden="true" style={{ flexShrink: 0, display: "flex", flexDirection: "column", alignItems: "center", alignSelf: "stretch", paddingTop: "var(--s1)" }}>
        <div style={{
          width: "var(--s2)", height: "var(--s2)", borderRadius: "50%",
          background: dotColor,
          border: "2px solid var(--surface)",
          boxShadow: `0 0 0 2px ${dotColor}`,
        }} />
        {!isLast && <div style={{ width: 1, flexGrow: 1, minHeight: "var(--s4)", background: "var(--line)", marginTop: "var(--s1)" }} />}
      </div>

      <div style={{ flex: 1, minWidth: 0, paddingBottom: isLast ? 0 : "var(--s1)" }}>
        <div style={{ display: "flex", gap: "var(--s3)", alignItems: "center", marginBottom: "var(--s2)", flexWrap: "wrap" }}>
          <a href={`/runs/${ep.runId}`} className="mono small" style={{ color: "var(--brand)" }} title={ep.runId}>
            {ep.runId.slice(0, 20)}…
          </a>
          <ProvBadge provenance={ep.provenance} />
          <span className="mono small muted" style={{ marginLeft: "auto" }}>{timeAgo(ep.ts)}</span>
        </div>
        <p
          className="small soft"
          style={{ margin: 0, lineHeight: 1.6, cursor: truncated ? "pointer" : "default" }}
          onClick={() => { if (truncated) setExpanded(v => !v); }}
        >
          {display}
        </p>
        {truncated && (
          <button onClick={() => setExpanded(v => !v)} className="btn btn-ghost btn-sm" style={{ marginTop: "var(--s2)", marginLeft: "calc(-1 * var(--s3))" }}>
            {expanded ? "Show less" : "Show more"}
          </button>
        )}
      </div>
    </div>
  );
}

function EpisodicPanel({ episodes }: { episodes: Episode[] }) {
  const [showAll, setShowAll] = useState(false);
  const sorted = [...episodes].sort((a, b) => b.ts - a.ts);
  const visible = showAll ? sorted : sorted.slice(0, 20);
  const hidden = sorted.length - visible.length;

  return (
    <div>
      <div style={{ display: "flex", alignItems: "baseline", gap: "var(--s3)", marginBottom: "var(--s4)" }}>
        <span className="h3">Run diaries</span>
        {episodes.length > 0 && <span className="badge badge-neutral mono">{episodes.length}</span>}
      </div>

      {episodes.length === 0 ? (
        <div className="state-empty small">
          <Glyph name="diary" size={26} />
          <p className="h3" style={{ color: "var(--ink-soft)", margin: 0 }}>No run diaries yet</p>
          <p style={{ maxWidth: "44ch", margin: 0 }}>
            A short, dated note the agent writes after each run shows up here. Add{" "}
            <code className="mono" style={{ background: "var(--surface-sunken)", padding: "var(--s1) var(--s2)", borderRadius: "var(--r-sm)" }}>remember</code>{" "}
            to a node to record one.
          </p>
        </div>
      ) : (
        <div className="card" style={{ overflow: "hidden", padding: 0 }}>
          {visible.map((ep, i) => (
            <EpisodeRow key={`${ep.runId}-${ep.ts}`} ep={ep} isLast={i === visible.length - 1 && hidden === 0} />
          ))}
          {hidden > 0 && (
            <button
              onClick={() => setShowAll(true)}
              className="btn btn-ghost btn-sm"
              style={{ width: "100%", borderTop: "1px solid var(--line)", borderRadius: 0 }}
            >
              Show {hidden} more
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ── Clear confirmation dialog ─────────────────────────────────────────────────

function ClearDialog({
  semanticCount, episodicCount,
  onConfirm, onCancel, confirming,
}: {
  semanticCount: number;
  episodicCount: number;
  onConfirm: () => Promise<void>;
  onCancel: () => void;
  confirming: boolean;
}) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Clear all memory"
      style={{
        position: "fixed", inset: 0, zIndex: 1000,
        background: "var(--backdrop-tint)", display: "flex", alignItems: "center", justifyContent: "center",
        padding: "var(--s5)", animation: "fade-in 150ms var(--ease) forwards",
      }}
      onClick={() => { if (!confirming) onCancel(); }}
    >
      <div
        className="card"
        style={{ padding: "var(--s6)", maxWidth: 440, width: "100%", boxShadow: "var(--shadow-lg)", borderTop: "3px solid var(--danger)" }}
        onClick={e => e.stopPropagation()}
      >
        <h3 className="h2" style={{ marginBottom: "var(--s3)" }}>
          Clear all memory?
        </h3>
        <p className="small soft" style={{ marginBottom: "var(--s5)", lineHeight: 1.6 }}>
          You will clear{" "}
          <strong className="mono" style={{ color: "var(--ink)" }}>{semanticCount}</strong>{" "}
          belief{semanticCount !== 1 ? "s" : ""} and{" "}
          <strong className="mono" style={{ color: "var(--ink)" }}>{episodicCount}</strong>{" "}
          run {episodicCount !== 1 ? "diaries" : "diary"}.
          The agent will start its next run with no prior knowledge. This cannot be undone.
        </p>
        <div style={{ display: "flex", gap: "var(--s3)", justifyContent: "flex-end" }}>
          <button className="btn btn-secondary" onClick={onCancel} disabled={confirming}>
            Cancel
          </button>
          <button
            className="btn btn-danger"
            disabled={confirming}
            onClick={() => void onConfirm()}
          >
            {confirming ? "Clearing…" : "Clear all memory"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Main tab ──────────────────────────────────────────────────────────────────

export default function MemoryTab({ agentId, agentIsRunning }: { agentId: string; agentIsRunning: boolean }) {
  const [data, setData] = useState<AgentMemory | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showClearDialog, setShowClearDialog] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await getAgentMemory(agentId));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [agentId]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3000);
    return () => clearTimeout(t);
  }, [toast]);

  async function handleClear() {
    setClearing(true);
    try {
      await clearAgentMemory(agentId);
      setShowClearDialog(false);
      setToast("Memory cleared");
      await load();
    } catch (e) {
      setToast(`Failed: ${(e as Error).message}`);
    } finally {
      setClearing(false);
    }
  }

  const semanticCount = data?.counts.semantic ?? 0;
  const episodicCount = data?.counts.episodic ?? 0;
  const isEmpty = !!data && semanticCount === 0 && episodicCount === 0;
  const hasFacts = semanticCount > 0;

  return (
    <div style={{ paddingBottom: "var(--s5)" }}>
      {/* Toast */}
      {toast && (
        <div className="small" role="status" style={{
          position: "fixed", top: "var(--s6)", right: "var(--s6)", zIndex: 2000,
          padding: "var(--s3) var(--s5)", borderRadius: "var(--r)",
          background: "var(--ink)", color: "var(--surface)",
          fontWeight: 600, boxShadow: "var(--shadow-lg)",
        }}>
          {toast}
        </div>
      )}

      {/* Clear dialog */}
      {showClearDialog && data && (
        <ClearDialog
          semanticCount={semanticCount}
          episodicCount={episodicCount}
          onConfirm={handleClear}
          onCancel={() => setShowClearDialog(false)}
          confirming={clearing}
        />
      )}

      {/* ── page header ── */}
      <div style={{
        display: "flex", justifyContent: "space-between", alignItems: "flex-start",
        gap: "var(--s4)", flexWrap: "wrap",
        paddingBottom: "var(--s5)", marginBottom: "var(--s6)",
        borderBottom: "1px solid var(--line)",
      }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: "var(--s3)", flexWrap: "wrap", marginBottom: "var(--s2)" }}>
            <h2 className="h1" style={{ margin: 0 }}>Memory &amp; Identity</h2>
            {agentIsRunning && (
              <span className="mem-live-badge" title="The agent is running — memory may be updating">
                <Glyph name="live" size={13} />
                <span className="mono">writing live</span>
              </span>
            )}
          </div>
          <p className="body-lg soft" style={{ margin: 0, maxWidth: "60ch" }}>
            What this agent knows, who it is, and where each fact came from — carried across runs.
          </p>
        </div>
        {hasFacts && !loading && !error && (
          <button
            className="btn btn-sm btn-danger"
            disabled={agentIsRunning || clearing}
            onClick={() => setShowClearDialog(true)}
            title={agentIsRunning ? "Cannot clear memory while the agent is running" : undefined}
            style={{ flexShrink: 0 }}
          >
            {clearing ? "Clearing…" : "Clear all memory"}
          </button>
        )}
      </div>

      {loading && (
        <div className="state-loading">
          <span className="spinner" aria-hidden="true" />
          <span>Loading memory…</span>
        </div>
      )}

      {error && (
        <div className="state-error" role="alert">
          <span>{error}</span>
        </div>
      )}

      {!loading && !error && (
        <>
          {/* Trust model banner — auto-hidden when memory is empty */}
          {!isEmpty && (
            <div className="badge-info" style={{
              display: "flex", alignItems: "flex-start", gap: "var(--s3)",
              padding: "var(--s3) var(--s5)", marginBottom: "var(--s6)",
              border: "1px solid var(--info)", borderRadius: "var(--r)",
              height: "auto",
            }}>
              <span style={{ flexShrink: 0, marginTop: "1px" }}><Glyph name="info" size={15} /></span>
              <p className="small" style={{ margin: 0, lineHeight: 1.55 }}>
                Facts with <strong>untrusted provenance are quarantined</strong> — they inform what the
                agent reads, but never authorize a consequential action.
              </p>
            </div>
          )}

          {/* Empty state — inviting, never blank */}
          {isEmpty ? (
            <div className="state-empty" style={{ padding: "var(--s9) var(--s6)" }}>
              <Glyph name="memory" size={40} />
              <p className="h2" style={{ color: "var(--ink)", margin: 0 }}>This agent has no memory yet</p>
              <p className="body-lg soft" style={{ maxWidth: "48ch", margin: 0 }}>
                Once it learns facts and writes run diaries, they show up here — each tagged
                with where it came from and which run produced it.
              </p>
              <p className="small" style={{ maxWidth: "48ch", margin: "var(--s2) 0 0" }}>
                Give a node a{" "}
                <code className="mono" style={{ background: "var(--surface-sunken)", padding: "var(--s1) var(--s2)", borderRadius: "var(--r-sm)" }}>recall</code>{" "}
                or{" "}
                <code className="mono" style={{ background: "var(--surface-sunken)", padding: "var(--s1) var(--s2)", borderRadius: "var(--r-sm)" }}>remember</code>{" "}
                capability to start building memory across runs.
              </p>
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: "var(--s7)" }}>
              {/* Identity (SOUL) */}
              <section>
                <SectionLabel>Identity</SectionLabel>
                <SoulPanel soul={data?.soul ?? null} />
              </section>

              {/* Beliefs (semantic facts) */}
              <section>
                <SectionLabel>Semantic facts</SectionLabel>
                {data && <SemanticFactsPanel facts={data.semantic} />}
              </section>

              {/* Run Diaries (episodic) */}
              <section>
                <SectionLabel>Episodic</SectionLabel>
                {data && <EpisodicPanel episodes={data.episodic} />}
              </section>
            </div>
          )}
        </>
      )}
    </div>
  );
}
