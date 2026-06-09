"use client";

import { useState, useEffect, useCallback } from "react";
import {
  getAgentMemory, clearAgentMemory, timeAgo,
  type AgentMemory, type SemanticFact, type Episode, type Provenance, type Soul,
} from "../../../lib/api";

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
      title={PROVENANCE_DESCRIPTION[provenance]}
      style={{
        fontSize: 10, fontWeight: 700, fontFamily: "var(--font-mono)", letterSpacing: ".04em",
        padding: "2px 6px", borderRadius: "var(--r-pill)", cursor: "help",
        background: trusted ? "var(--ok-tint)" : "var(--danger-tint)",
        color: trusted ? "var(--ok)" : "var(--danger)",
      }}
    >
      {PROVENANCE_LABEL[provenance]}
    </span>
  );
}

// ── Soul panel ────────────────────────────────────────────────────────────────

function SoulPanel({ soul }: { soul: Soul | null }) {
  if (!soul) {
    return (
      <div className="card" style={{ padding: "var(--s5)", borderLeft: "3px solid var(--ink-muted)", marginBottom: "var(--s5)" }}>
        <span style={{ fontWeight: 600, fontSize: 14, color: "var(--ink)" }}>Identity</span>
        <p style={{ fontSize: 13, color: "var(--ink-soft)", margin: "var(--s2) 0 0" }}>
          No identity configured. Run the agent with an <code>identify</code> capability to establish its name, values, and standing instructions.
        </p>
      </div>
    );
  }

  const isBootstrap = soul.version === 0;

  return (
    <div className="card" style={{ padding: "var(--s5)", borderLeft: "3px solid var(--brand)", marginBottom: "var(--s5)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "var(--s4)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "var(--s3)" }}>
          <span style={{ fontWeight: 600, fontSize: 14, color: "var(--ink)" }}>Identity</span>
          <span style={{
            fontSize: 10, fontWeight: 700, padding: "2px 6px", borderRadius: "var(--r-pill)",
            background: isBootstrap ? "var(--canvas)" : "var(--ok-tint)",
            color: isBootstrap ? "var(--ink-muted)" : "var(--ok)",
            fontFamily: "var(--font-mono)",
          }}>
            v{soul.version}{isBootstrap ? " · default" : ""}
          </span>
        </div>
      </div>

      <div style={{ marginBottom: "var(--s4)" }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: "var(--ink-muted)", textTransform: "uppercase", letterSpacing: ".06em", marginBottom: "var(--s2)" }}>Name</div>
        <div style={{ fontSize: 14, color: "var(--ink)", fontWeight: 500 }}>{soul.name}</div>
      </div>

      <div style={{ marginBottom: "var(--s4)" }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: "var(--ink-muted)", textTransform: "uppercase", letterSpacing: ".06em", marginBottom: "var(--s2)" }}>Values</div>
        {soul.values.length === 0
          ? <span style={{ fontSize: 13, color: "var(--ink-muted)", fontStyle: "italic" }}>none set — run with identify capability to add values</span>
          : <ul style={{ margin: 0, paddingLeft: "var(--s5)" }}>
              {soul.values.map((v, i) => (
                <li key={i} style={{ fontSize: 13, color: "var(--ink)", marginBottom: "var(--s1)" }}>{v}</li>
              ))}
            </ul>
        }
      </div>

      <div>
        <div style={{ fontSize: 11, fontWeight: 600, color: "var(--ink-muted)", textTransform: "uppercase", letterSpacing: ".06em", marginBottom: "var(--s2)" }}>Standing Instructions</div>
        {soul.standingInstructions.length === 0
          ? <span style={{ fontSize: 13, color: "var(--ink-muted)", fontStyle: "italic" }}>none set</span>
          : <ol style={{ margin: 0, paddingLeft: "var(--s5)" }}>
              {soul.standingInstructions.map((inst, i) => (
                <li key={i} style={{ fontSize: 13, color: "var(--ink)", marginBottom: "var(--s2)" }}>{inst}</li>
              ))}
            </ol>
        }
      </div>
    </div>
  );
}

// ── Semantic facts ────────────────────────────────────────────────────────────

function FactRow({ fact }: { fact: SemanticFact }) {
  const ps = provStyle(fact.provenance);
  const derivedRunId = fact.derivedFrom[0];
  return (
    <div style={{
      ...ps,
      display: "grid",
      gridTemplateColumns: "180px 1fr 90px 48px 140px 80px",
      gap: "var(--s3)",
      alignItems: "center",
      padding: "var(--s3) var(--s4)",
      borderBottom: "1px solid var(--line)",
    }}>
      <span style={{ fontFamily: "var(--font-mono)", fontSize: 12, fontWeight: 600, color: "var(--ink)", wordBreak: "break-all" }}>
        {fact.key}
      </span>
      <span style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--ink-soft)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
        title={String(fact.value)}>
        {String(fact.value)}
      </span>
      <ProvBadge provenance={fact.provenance} />
      <span style={{ fontSize: 11, color: "var(--ink-muted)", textAlign: "center" }}
        title={`Version ${fact.version}`}>
        v{fact.version}
      </span>
      <span style={{ fontSize: 11, color: "var(--ink-muted)" }}>
        {derivedRunId ? (
          <a href={`/runs/${derivedRunId}`} style={{ color: "var(--brand)", fontFamily: "var(--font-mono)" }}>
            {derivedRunId.slice(0, 14)}…
          </a>
        ) : "—"}
      </span>
      <span className="small muted" style={{ textAlign: "right" }}>{timeAgo(fact.ts)}</span>
    </div>
  );
}

function SemanticFactsPanel({
  facts,
  agentIsRunning,
  onClearAll,
  clearing,
}: {
  facts: SemanticFact[];
  agentIsRunning: boolean;
  onClearAll: () => void;
  clearing: boolean;
}) {
  const sorted = [...facts].sort((a, b) => b.ts - a.ts);
  return (
    <div style={{ marginBottom: "var(--s6)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "var(--s3)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "var(--s3)" }}>
          <span style={{ fontWeight: 600, fontSize: 14 }}>Beliefs</span>
          {facts.length > 0 && (
            <span style={{ fontSize: 11, fontWeight: 600, padding: "2px 8px", borderRadius: "var(--r-pill)", background: "var(--brand-tint)", color: "var(--brand)" }}>
              {facts.length}
            </span>
          )}
        </div>
        {facts.length > 0 && (
          <button
            className="btn btn-sm"
            disabled={agentIsRunning || clearing}
            onClick={onClearAll}
            style={{ color: "var(--danger)", borderColor: "rgba(185,28,28,.25)", opacity: agentIsRunning ? .5 : 1 }}
            title={agentIsRunning ? "Cannot clear memory while agent is running" : undefined}
          >
            {clearing ? "Clearing…" : "Clear all memory"}
          </button>
        )}
      </div>

      {facts.length === 0 ? (
        <div style={{ padding: "var(--s6)", border: "1.5px dashed var(--line-strong)", borderRadius: "var(--r)", color: "var(--ink-muted)", fontSize: 13, textAlign: "center" }}>
          No beliefs yet. Add <code style={{ fontSize: 12, background: "var(--surface-sunken)", padding: "1px 5px", borderRadius: 4 }}>remember</code> to a node to start building beliefs across runs.
        </div>
      ) : (
        <div className="card" style={{ overflow: "hidden", padding: 0 }}>
          {/* table header */}
          <div style={{
            display: "grid", gridTemplateColumns: "180px 1fr 90px 48px 140px 80px",
            gap: "var(--s3)", padding: "var(--s2) var(--s4)",
            background: "var(--surface-sunken)", borderBottom: "1px solid var(--line)",
          }}>
            {["Key", "Value", "Trust", "Ver", "From run", "When"].map((h, i) => (
              <span key={h} className="micro" style={{ textAlign: i >= 5 ? "right" : "left" }}>{h}</span>
            ))}
          </div>
          {sorted.map(f => <FactRow key={f.key} fact={f} />)}
        </div>
      )}
    </div>
  );
}

// ── Episodic log ──────────────────────────────────────────────────────────────

function EpisodeRow({ ep, index }: { ep: Episode; index: number }) {
  const [expanded, setExpanded] = useState(false);
  const truncated = ep.summary.length > 200;
  const display = expanded || !truncated ? ep.summary : ep.summary.slice(0, 200) + "…";
  return (
    <div style={{
      display: "flex", gap: "var(--s4)", padding: "var(--s4) var(--s5)",
      borderBottom: "1px solid var(--line)", alignItems: "flex-start",
    }}>
      {/* timeline dot */}
      <div style={{ flexShrink: 0, display: "flex", flexDirection: "column", alignItems: "center", paddingTop: 4 }}>
        <div style={{
          width: 10, height: 10, borderRadius: "50%",
          background: isTrusted(ep.provenance) ? "var(--brand)" : "var(--danger)",
          border: "2px solid var(--surface)",
          boxShadow: `0 0 0 2px ${isTrusted(ep.provenance) ? "var(--brand)" : "var(--danger)"}`,
        }} />
        {index > 0 && <div style={{ width: 1, flexGrow: 1, minHeight: 12, background: "var(--line)", marginTop: 4 }} />}
      </div>

      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", gap: "var(--s3)", alignItems: "center", marginBottom: "var(--s2)", flexWrap: "wrap" }}>
          <a href={`/runs/${ep.runId}`} style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--brand)" }}>
            {ep.runId.slice(0, 20)}…
          </a>
          <ProvBadge provenance={ep.provenance} />
          <span className="small muted">{timeAgo(ep.ts)}</span>
        </div>
        <p style={{ margin: 0, fontSize: 13, color: "var(--ink-soft)", lineHeight: 1.5 }}>{display}</p>
        {truncated && (
          <button onClick={() => setExpanded(v => !v)}
            style={{ background: "none", border: "none", padding: 0, fontSize: 11, color: "var(--brand)", cursor: "pointer", marginTop: "var(--s1)" }}>
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
      <div style={{ display: "flex", alignItems: "center", gap: "var(--s3)", marginBottom: "var(--s3)" }}>
        <span style={{ fontWeight: 600, fontSize: 14 }}>Run Diaries</span>
        {episodes.length > 0 && (
          <span style={{ fontSize: 11, fontWeight: 600, padding: "2px 8px", borderRadius: "var(--r-pill)", background: "var(--brand-tint)", color: "var(--brand)" }}>
            {episodes.length}
          </span>
        )}
      </div>

      {episodes.length === 0 ? (
        <div style={{ padding: "var(--s6)", border: "1.5px dashed var(--line-strong)", borderRadius: "var(--r)", color: "var(--ink-muted)", fontSize: 13, textAlign: "center" }}>
          No run diaries yet. Add <code style={{ fontSize: 12, background: "var(--surface-sunken)", padding: "1px 5px", borderRadius: 4 }}>remember</code> to a node to record a diary after each run.
        </div>
      ) : (
        <div className="card" style={{ overflow: "hidden", padding: 0 }}>
          {visible.map((ep, i) => <EpisodeRow key={`${ep.runId}-${ep.ts}`} ep={ep} index={i} />)}
          {hidden > 0 && (
            <button
              onClick={() => setShowAll(true)}
              style={{
                width: "100%", padding: "var(--s4)", background: "var(--surface-sunken)",
                border: "none", cursor: "pointer", fontSize: 13, color: "var(--brand)",
                borderTop: "1px solid var(--line)",
              }}
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
    <div style={{
      position: "fixed", inset: 0, zIndex: 1000,
      background: "rgba(0,0,0,.4)", display: "flex", alignItems: "center", justifyContent: "center",
    }}>
      <div className="card" style={{ padding: "var(--s6)", maxWidth: 420, width: "90%", boxShadow: "var(--shadow-md)" }}>
        <h3 style={{ fontSize: 16, fontWeight: 700, marginBottom: "var(--s4)", color: "var(--danger)" }}>
          Clear all memory?
        </h3>
        <p style={{ fontSize: 13, color: "var(--ink-soft)", marginBottom: "var(--s5)", lineHeight: 1.6 }}>
          This will permanently clear <strong>{semanticCount} belief{semanticCount !== 1 ? "s" : ""}</strong> and{" "}
          <strong>{episodicCount} run {episodicCount !== 1 ? "diaries" : "diary"}</strong>.
          The agent will start its next run with no prior knowledge. This cannot be undone.
        </p>
        <div style={{ display: "flex", gap: "var(--s3)", justifyContent: "flex-end" }}>
          <button className="btn btn-secondary" onClick={onCancel} disabled={confirming}>
            Cancel
          </button>
          <button
            className="btn"
            style={{ background: "var(--danger)", color: "white", border: "none", fontWeight: 600, opacity: confirming ? .6 : 1 }}
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

  const isEmpty = data && data.counts.semantic === 0 && data.counts.episodic === 0;

  return (
    <div style={{ paddingTop: "var(--s5)", paddingBottom: "var(--s9)" }}>
      {/* Toast */}
      {toast && (
        <div style={{
          position: "fixed", top: "var(--s6)", right: "var(--s6)", zIndex: 2000,
          padding: "var(--s3) var(--s5)", borderRadius: "var(--r)",
          background: "var(--ok)", color: "white",
          fontSize: 13, fontWeight: 600, boxShadow: "var(--shadow-md)",
        }}>
          {toast}
        </div>
      )}

      {/* Clear dialog */}
      {showClearDialog && data && (
        <ClearDialog
          semanticCount={data.counts.semantic}
          episodicCount={data.counts.episodic}
          onConfirm={handleClear}
          onCancel={() => setShowClearDialog(false)}
          confirming={clearing}
        />
      )}

      {loading && <p className="soft small">Loading memory…</p>}
      {error && (
        <div style={{ padding: "var(--s4) var(--s5)", background: "var(--danger-tint)", border: "1px solid rgba(185,28,28,.2)", borderRadius: "var(--r)", color: "var(--danger)", fontSize: 13, marginBottom: "var(--s5)" }}>
          {error}
        </div>
      )}

      {!loading && !error && (
        <>
          {/* Trust banner — always visible when there is any data */}
          {!isEmpty && (
            <div style={{
              padding: "var(--s3) var(--s5)", marginBottom: "var(--s5)",
              background: "var(--brand-tint)", border: "1px solid rgba(14,124,117,.15)",
              borderRadius: "var(--r)", fontSize: 12, color: "var(--brand)",
            }}>
              Facts with untrusted provenance are quarantined — they inform reads but never authorize consequential actions.
            </div>
          )}

          {/* Empty state */}
          {isEmpty && (
            <div style={{
              padding: "var(--s9)", textAlign: "center",
              border: "1.5px dashed var(--line-strong)", borderRadius: "var(--r)",
              color: "var(--ink-muted)", marginBottom: "var(--s6)",
            }}>
              <div style={{ fontSize: 32, marginBottom: "var(--s4)" }}>🧠</div>
              <p style={{ fontSize: 15, fontWeight: 600, marginBottom: "var(--s2)", color: "var(--ink-soft)" }}>No memory yet</p>
              <p style={{ fontSize: 13, maxWidth: 380, margin: "0 auto" }}>
                This agent doesn&apos;t use memory capabilities. Add{" "}
                <code style={{ fontSize: 12, background: "var(--surface-sunken)", padding: "1px 5px", borderRadius: 4 }}>recall</code> or{" "}
                <code style={{ fontSize: 12, background: "var(--surface-sunken)", padding: "1px 5px", borderRadius: 4 }}>remember</code>{" "}
                to a node to start building beliefs across runs.
              </p>
            </div>
          )}

          {/* Identity (SOUL) */}
          <SoulPanel soul={data?.soul ?? null} />

          {/* Beliefs (semantic facts) */}
          {data && (
            <SemanticFactsPanel
              facts={data.semantic}
              agentIsRunning={agentIsRunning}
              onClearAll={() => setShowClearDialog(true)}
              clearing={clearing}
            />
          )}

          {/* Run Diaries (episodic) */}
          {data && <EpisodicPanel episodes={data.episodic} />}
        </>
      )}
    </div>
  );
}
