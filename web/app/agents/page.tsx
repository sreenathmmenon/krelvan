"use client";

// Agents index — the dedicated management surface for every agent you own. Distinct from the
// Dashboard (a workspace overview); this is the searchable, full list you act on: run, open, delete.
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { listAgents, listRuns, startRun } from "../../lib/api";
import { AgentCard } from "../_builder";
import type { AgentRecord, RunRecord } from "../../lib/api";

export default function AgentsPage() {
  const router = useRouter();
  const [agents, setAgents] = useState<AgentRecord[] | null>(null);
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [query, setQuery] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const [a, r] = await Promise.all([listAgents(), listRuns()]);
      setAgents(a);
      setRuns(r);
      setErr(null);
    } catch (e) {
      setErr((e as Error)?.message ?? "Could not load agents");
      setAgents([]);
    }
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  const filtered = useMemo(() => {
    if (!agents) return [];
    const q = query.trim().toLowerCase();
    if (!q) return agents;
    return agents.filter(a => {
      const m = a.signed.manifest;
      return (m.name ?? "").toLowerCase().includes(q) || (m.intent ?? "").toLowerCase().includes(q);
    });
  }, [agents, query]);

  return (
    <div className="container" style={{ paddingTop: "var(--s7)", paddingBottom: "var(--s9)" }}>
      <p className="micro" style={{ marginBottom: "var(--s3)" }}>Your agents</p>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-end", justifyContent: "space-between", gap: "var(--s4)", marginBottom: "var(--s6)" }}>
        <div style={{ minWidth: 0 }}>
          <h1 className="h1" style={{ marginBottom: "var(--s2)" }}>Agents</h1>
          <p className="body-lg soft" style={{ margin: 0, maxWidth: "56ch" }}>
            Every agent you own, in one place. Run one, open it to edit or watch it work, or remove it.
          </p>
        </div>
        <Link href="/#builder" className="btn btn-primary">Build agent</Link>
      </div>

      {agents !== null && agents.length > 6 && (
        <input
          className="input"
          type="search"
          placeholder={`Search ${agents.length} agents…`}
          value={query}
          onChange={e => setQuery(e.target.value)}
          aria-label="Search agents"
          style={{ maxWidth: 360, marginBottom: "var(--s5)" }}
        />
      )}

      {err ? (
        <div className="card" style={{ padding: "var(--s6)", textAlign: "center" }}>
          <p className="small soft" style={{ marginBottom: "var(--s3)" }}>{err}</p>
          <button className="btn" onClick={() => void reload()}>Retry</button>
        </div>
      ) : agents === null ? (
        <div className="builder-agents">
          {[0, 1, 2].map(i => <div key={i} className="skeleton skeleton-card" style={{ height: 200 }} />)}
        </div>
      ) : agents.length === 0 ? (
        <div className="card" style={{ padding: "var(--s7)", textAlign: "center", display: "flex", flexDirection: "column", alignItems: "center", gap: "var(--s3)" }}>
          <p className="body-lg" style={{ margin: 0 }}>No agents yet.</p>
          <p className="small soft" style={{ maxWidth: "40ch", lineHeight: 1.6 }}>
            Describe an outcome in plain English and Krelvan builds the agent for you — or install one from the Marketplace.
          </p>
          <div style={{ display: "flex", gap: "var(--s3)", marginTop: "var(--s2)" }}>
            <Link href="/#builder" className="btn btn-primary">Build an agent</Link>
            <Link href="/capabilities" className="btn">Browse Marketplace</Link>
          </div>
        </div>
      ) : filtered.length === 0 ? (
        <p className="small soft">No agents match “{query}”. <button className="btn-link" onClick={() => setQuery("")}>Clear</button></p>
      ) : (
        <div className="builder-agents">
          {filtered.map(a => {
            const agentRuns = runs.filter(r => r.agentId === a.id);
            return (
              <AgentCard
                key={a.id}
                agent={a}
                agentRuns={agentRuns}
                onRun={() => { void startRun(a.id).then(r => { void reload(); router.push(`/runs/${r.runId}`); }); }}
                onDelete={() => { void reload(); }}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
