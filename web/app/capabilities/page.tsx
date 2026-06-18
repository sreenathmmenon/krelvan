"use client";
import { useState, useEffect, useMemo, useCallback } from "react";
import {
  listCapabilities, installCapability, installCapabilityFile, installTemplate,
  enableCapability, disableCapability, uninstallCapability,
  listMcpServers, connectMcpServer, disconnectMcpServer,
  getCapabilitySource, updateCapabilityYaml,
  type CapabilityRecord, type McpServerRecord,
} from "../../lib/api";
import { loadRegistry, type CatalogEntry } from "../../lib/registry";
import { sideEffectMeta, toneColors, needsApproval, type Autonomy } from "../../lib/sideEffects";

// ── Capabilities — "what your agents can do" ─────────────────────────────────
// Flagship page. Two tabs: INSTALLED (control panel) + DISCOVER (marketplace).
// MCP is folded in as the "Connectors" subsection. The trust differentiator —
// every capability's side-effect class + when it pauses for approval — is the
// visual centerpiece (spectrum band + live approval simulator).

// ── small SVG glyphs (no emoji) ──────────────────────────────────────────────
function Glyph({ d, size = 16 }: { d: string; size?: number }) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} fill="none" aria-hidden="true" style={{ display: "block" }}>
      <path d={d} stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
const ICON = {
  search: "M7 12.5a5.5 5.5 0 1 0 0-11 5.5 5.5 0 0 0 0 11zM11 11l3.5 3.5",
  bolt: "M8 1.6l1.7 4.7L14.4 8l-4.7 1.7L8 14.4l-1.7-4.7L1.6 8l4.7-1.7L8 1.6z",
  plug: "M5 1.5v3M11 1.5v3M3.5 4.5h9v3a4.5 4.5 0 0 1-9 0v-3zM8 12v2.5",
  check: "M3.5 8.5l3 3 6-6.5",
  shield: "M8 1.6l5 1.8v3.4c0 3.2-2.1 5.4-5 6.2-2.9-.8-5-3-5-6.2V3.4L8 1.6z",
};

const AUTONOMY_OPTS: { key: Autonomy; label: string; hint: string }[] = [
  { key: "suggest",       label: "Suggest",       hint: "asks before every action" },
  { key: "act-with-veto", label: "Act-with-veto", hint: "asks before risky actions" },
  { key: "full",          label: "Full",          hint: "only asks to spend or change access" },
];

function SideEffectBadge({ effect, gated }: { effect: string; gated?: boolean }) {
  const m = sideEffectMeta(effect);
  const c = toneColors(m.tone);
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: "5px",
      height: 22, padding: "0 var(--s2)", borderRadius: "var(--r-pill)",
      background: c.bg, color: c.fg, fontSize: 11, fontWeight: 600, whiteSpace: "nowrap",
    }}>
      {m.label}
      {gated && <span title="Pauses for your approval" style={{ opacity: .85 }}>· pauses ✋</span>}
    </span>
  );
}


export default function CapabilitiesPage() {
  const [tab, setTab] = useState<"installed" | "discover">("installed");
  const [caps, setCaps] = useState<CapabilityRecord[]>([]);
  const [servers, setServers] = useState<McpServerRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [autonomy, setAutonomy] = useState<Autonomy>("act-with-veto");
  const [query, setQuery] = useState("");
  const [toast, setToast] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [viewing, setViewing] = useState<CapabilityRecord | null>(null);

  const reload = useCallback(async () => {
    try {
      const [c, s] = await Promise.all([listCapabilities(), listMcpServers().catch(() => [])]);
      setCaps(c); setServers(s);
    } catch { /* ignore */ }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void reload(); }, [reload]);
  // Load the marketplace registry (live from GitHub if configured, else bundled seed).
  useEffect(() => { void loadRegistry().then(r => setCatalog(r.entries)); }, []);

  function flash(msg: string) { setToast(msg); setTimeout(() => setToast(null), 3500); }

  const q = query.trim().toLowerCase();
  const installedNames = useMemo(() => new Set(caps.map(c => c.name)), [caps]);

  // header stats
  const activeCount = caps.filter(c => c.kind === "builtin" || c.status === "enabled").length;
  const builtinCount = caps.filter(c => c.kind === "builtin").length;

  return (
    <div className="container" style={{ paddingTop: "var(--s7)", paddingBottom: "var(--s9)" }}>
      {/* ── header ── */}
      <p className="micro" style={{ marginBottom: "var(--s3)" }}>What your agents can do</p>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "var(--s4)", flexWrap: "wrap", marginBottom: "var(--s5)" }}>
        <div style={{ minWidth: 0 }}>
          <h1 className="h1" style={{ marginBottom: "var(--s2)" }}>Capabilities</h1>
          <p className="body-lg soft" style={{ margin: 0, maxWidth: "56ch" }}>
            The tools your agents reach for — each labelled with exactly what it can touch
            and when it pauses to ask you. Nothing hidden.
          </p>
        </div>
        <div style={{ display: "flex", gap: "var(--s4)", flexShrink: 0 }}>
          <Stat value={String(activeCount)} label="active" />
          <Stat value={String(builtinCount)} label="built-in" />
          <Stat value={String(servers.filter(s => s.connected).length)} label="connectors" />
        </div>
      </div>

      {/* ── side-effect spectrum + approval simulator (the wow) ── */}
      <Spectrum caps={caps} autonomy={autonomy} setAutonomy={setAutonomy} />

      {/* ── tabs ── */}
      <div className="cap-tabs" role="tablist" aria-label="Capabilities views">
        <button role="tab" aria-selected={tab === "installed"} className="cap-tab" data-on={tab === "installed"} onClick={() => setTab("installed")}>
          Installed <span className="mono cap-tab__n">{caps.length}</span>
        </button>
        <button role="tab" aria-selected={tab === "discover"} className="cap-tab" data-on={tab === "discover"} onClick={() => setTab("discover")}>
          Discover <span className="mono cap-tab__n">{catalog.length}</span>
        </button>
      </div>

      {/* search */}
      <div className="cap-search" style={{ margin: "var(--s5) 0", maxWidth: 440 }}>
        <span className="cap-search__icon" style={{ color: "var(--ink-muted)" }}><Glyph d={ICON.search} /></span>
        <input className="input cap-search__input" type="search" placeholder={tab === "installed" ? "Search installed…" : "Search the catalog…"} value={query} onChange={e => setQuery(e.target.value)} aria-label="Search capabilities" />
      </div>

      {loading && tab === "installed" ? (
        <div className="state-loading"><span className="spinner" aria-hidden="true" /><span>Loading capabilities…</span></div>
      ) : tab === "installed" ? (
        <InstalledTab caps={caps} servers={servers} q={q} autonomy={autonomy} onChange={reload} flash={flash} onView={setViewing} />
      ) : (
        <DiscoverTab catalog={catalog} q={q} installedNames={installedNames} onInstalled={reload} flash={flash} />
      )}

      {toast && (
        <div role="status" className="cap-toast">
          <span className="cap-toast__mark" aria-hidden="true"><Glyph d={ICON.check} size={13} /></span>{toast}
        </div>
      )}

      {viewing && (
        <SourceDrawer cap={viewing} onClose={() => setViewing(null)} onSaved={reload} flash={flash} />
      )}
    </div>
  );
}

// ── Source drawer: view (read-only) or edit (YAML) a capability ──────────────
function SourceDrawer({ cap, onClose, onSaved, flash }: { cap: CapabilityRecord; onClose: () => void; onSaved: () => Promise<void>; flash: (m: string) => void }) {
  const [src, setSrc] = useState<{ kind: string; editable: boolean; content: string } | null>(null);
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void getCapabilitySource(cap.name).then(s => { if (alive) { setSrc(s); setDraft(s.content); } }).catch(e => { if (alive) setErr((e as Error).message); });
    return () => { alive = false; };
  }, [cap.name]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") onClose(); }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function save() {
    setBusy(true); setErr(null);
    try { await updateCapabilityYaml(cap.name, draft); await onSaved(); flash(`${cap.name} updated`); setEditing(false); setSrc(s => s ? { ...s, content: draft } : s); }
    catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  }

  return (
    <>
      <button className="nav-scrim" aria-label="Close" onClick={onClose} style={{ inset: 0 }} />
      <aside className="cap-drawer" role="dialog" aria-modal="true" aria-label={`Source for ${cap.name}`}>
        <div className="cap-drawer__head">
          <div style={{ minWidth: 0 }}>
            <div className="h3 mono text-truncate" style={{ color: "var(--ink)" }}>{cap.name}</div>
            <div className="small muted">{cap.kind} · {sideEffectMeta(cap.sideEffect).label}</div>
          </div>
          <button className="btn btn-ghost btn-sm" onClick={onClose} aria-label="Close" style={{ width: 32, padding: 0 }}>✕</button>
        </div>
        <div className="cap-drawer__body">
          {cap.description && <p className="small soft" style={{ marginBottom: "var(--s4)", lineHeight: 1.55 }}>{cap.description}</p>}
          {err && <div className="state-error" style={{ marginBottom: "var(--s4)" }}>{err}</div>}
          {!src ? (
            <div className="state-loading"><span className="spinner" aria-hidden="true" /><span>Loading source…</span></div>
          ) : editing && src.editable ? (
            <>
              <textarea className="input input-mono" value={draft} onChange={e => setDraft(e.target.value)} rows={18} style={{ width: "100%", lineHeight: 1.5, fontSize: 12 }} />
              <div style={{ display: "flex", gap: "var(--s2)", marginTop: "var(--s3)" }}>
                <button className="btn btn-primary btn-sm" disabled={busy} onClick={save}>{busy ? "Saving…" : "Save & reload"}</button>
                <button className="btn btn-ghost btn-sm" onClick={() => { setEditing(false); setDraft(src.content); setErr(null); }}>Cancel</button>
              </div>
            </>
          ) : (
            <>
              <pre className="cap-drawer__code">{src.content}</pre>
              {src.editable && (
                <button className="btn btn-secondary btn-sm" style={{ marginTop: "var(--s3)" }} onClick={() => setEditing(true)}>Edit YAML</button>
              )}
            </>
          )}
        </div>
      </aside>
    </>
  );
}

function Stat({ value, label, mono }: { value: string; label: string; mono?: boolean }) {
  return (
    <div style={{ textAlign: "right" }}>
      <div className={mono ? "mono" : "mono"} style={{ fontSize: 22, fontWeight: 600, color: "var(--ink)", lineHeight: 1.1 }}>{value}</div>
      <div className="micro" style={{ color: "var(--ink-muted)" }}>{label}</div>
    </div>
  );
}

// ── Spectrum band + live approval simulator ──────────────────────────────────
function Spectrum({ caps, autonomy, setAutonomy }: { caps: CapabilityRecord[]; autonomy: Autonomy; setAutonomy: (a: Autonomy) => void }) {
  const [showAll, setShowAll] = useState(false);
  // bucket caps by tier 0/1/2
  const buckets: Record<0 | 1 | 2, CapabilityRecord[]> = { 0: [], 1: [], 2: [] };
  for (const c of caps) buckets[sideEffectMeta(c.sideEffect).tier].push(c);
  const gatedCount = caps.filter(c => needsApproval(autonomy, c.sideEffect)).length;
  const PER_ZONE = 8;
  const hiddenCount = caps.length - ([0, 1, 2] as const).reduce<number>((n, t) => n + Math.min(buckets[t].length, PER_ZONE), 0);

  return (
    <div className="cap-spectrum">
      <div className="cap-spectrum__row">
        <div className="cap-spectrum__head">
          <span className="micro" style={{ color: "var(--ink-soft)" }}>Every capability, by what it can do</span>
          <span className="small muted">
            At <b style={{ color: "var(--brand)" }}>{autonomy}</b> autonomy,{" "}
            <span className="mono" style={{ color: "var(--ink)" }}>{gatedCount}</span> of{" "}
            <span className="mono" style={{ color: "var(--ink)" }}>{caps.length}</span> pause for your approval.
          </span>
        </div>
        <div className="cap-sim" role="group" aria-label="Autonomy simulator">
          {AUTONOMY_OPTS.map(o => (
            <button key={o.key} className="cap-sim__btn" data-on={autonomy === o.key} title={o.hint} onClick={() => setAutonomy(o.key)}>{o.label}</button>
          ))}
        </div>
      </div>
      <div className="cap-spectrum__band">
        {([0, 1, 2] as const).map(tier => {
          const all = buckets[tier];
          const shown = showAll ? all : all.slice(0, PER_ZONE);
          return (
          <div key={tier} className={`cap-spectrum__zone cap-spectrum__zone--${tier}`}>
            <span className="micro cap-spectrum__zlabel">{tier === 0 ? "Reads" : tier === 1 ? "Acts (reversible)" : "High-impact"}</span>
            <div className="cap-spectrum__chips">
              {shown.map(c => {
                const gated = needsApproval(autonomy, c.sideEffect);
                return <span key={c.name} className="cap-spectrum__chip" data-gated={gated} title={`${c.name} — ${sideEffectMeta(c.sideEffect).label}${gated ? " · pauses for approval" : ""}`}>{c.name}</span>;
              })}
              {all.length === 0 && <span className="small muted">—</span>}
              {!showAll && all.length > PER_ZONE && <span className="cap-spectrum__chip" style={{ borderStyle: "dashed" }}>+{all.length - PER_ZONE}</span>}
            </div>
          </div>
          );
        })}
      </div>
      {(showAll || hiddenCount > 0) && (
        <div style={{ marginTop: "var(--s4)" }}>
          <button className="btn btn-ghost btn-sm" onClick={() => setShowAll(s => !s)}>
            {showAll ? "Show fewer" : `Show all ${caps.length} capabilities`}
          </button>
        </div>
      )}
    </div>
  );
}

// ── Installed tab ────────────────────────────────────────────────────────────
function InstalledTab({ caps, servers, q, autonomy, onChange, flash, onView }: {
  caps: CapabilityRecord[]; servers: McpServerRecord[]; q: string; autonomy: Autonomy;
  onChange: () => Promise<void>; flash: (m: string) => void; onView: (c: CapabilityRecord) => void;
}) {
  const filtered = caps.filter(c => !q || `${c.name} ${c.description ?? ""}`.toLowerCase().includes(q));
  const builtins = filtered.filter(c => c.kind === "builtin");
  const plugins = filtered.filter(c => c.kind !== "builtin");

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--s7)" }}>
      {plugins.length > 0 && (
        <Section title="Your plugins" sub="Installed by you — enable, disable, or remove">
          <div className="cap-grid">{plugins.map(c => <CapCard key={c.name} cap={c} autonomy={autonomy} onChange={onChange} flash={flash} onView={onView} />)}</div>
        </Section>
      )}

      {/* Connectors (MCP folded in) — anchor target for /mcp redirect + nav deep-links */}
      <div id="connectors" style={{ scrollMarginTop: "var(--s8)" }} />
      <Connectors servers={servers} onChange={onChange} flash={flash} />

      <BuiltinSection builtins={builtins} autonomy={autonomy} onChange={onChange} flash={flash} onView={onView} />
    </div>
  );
}

// Built-in capabilities can be 20+. Show the first 8; the long tail is behind a
// toggle so the page doesn't read as an endless wall (council P0-5).
function BuiltinSection({ builtins, autonomy, onChange, flash, onView }: {
  builtins: CapabilityRecord[]; autonomy: Autonomy; onChange: () => Promise<void>; flash: (m: string) => void; onView: (c: CapabilityRecord) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const FIRST = 8;
  const shown = showAll ? builtins : builtins.slice(0, FIRST);
  const hidden = builtins.length - shown.length;
  return (
    <Section title="Built-in" sub={`Shipped with Krelvan — always available · ${builtins.length}`}>
      <div className="cap-grid">{shown.map(c => <CapCard key={c.name} cap={c} autonomy={autonomy} onChange={onChange} flash={flash} onView={onView} />)}</div>
      {(hidden > 0 || showAll) && builtins.length > FIRST && (
        <div style={{ marginTop: "var(--s4)", textAlign: "center" }}>
          <button className="btn btn-secondary btn-sm" onClick={() => setShowAll(v => !v)}>
            {showAll ? "Show fewer" : `Show all ${builtins.length} built-in capabilities →`}
          </button>
        </div>
      )}
    </Section>
  );
}

function Section({ title, sub, children }: { title: string; sub: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={{ display: "flex", alignItems: "baseline", gap: "var(--s3)", marginBottom: "var(--s4)", flexWrap: "wrap" }}>
        <span className="micro" style={{ color: "var(--ink)" }}>{title}</span>
        <span className="small muted">{sub}</span>
      </div>
      {children}
    </div>
  );
}

function CapCard({ cap, autonomy, onChange, flash, onView }: { cap: CapabilityRecord; autonomy: Autonomy; onChange: () => Promise<void>; flash: (m: string) => void; onView: (c: CapabilityRecord) => void }) {
  const [busy, setBusy] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const gated = needsApproval(autonomy, cap.sideEffect);
  const isPlugin = cap.kind !== "builtin";
  async function act(fn: () => Promise<unknown>, msg: string) {
    setBusy(true);
    try { await fn(); await onChange(); flash(msg); } catch (e) { flash((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <div className="card cap-card">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "var(--s2)" }}>
        <div className="h3 mono text-truncate" style={{ color: "var(--ink)" }}>{cap.name}</div>
        {cap.status === "enabled" && <span className="badge badge-done"><span className="dot" />on</span>}
        {cap.status === "disabled" && <span className="badge badge-neutral">off</span>}
        {cap.kind === "builtin" && <span className="micro" style={{ color: "var(--ink-muted)" }}>always on</span>}
      </div>
      {cap.description && <p className="small" style={{ color: "var(--ink-soft)", margin: 0, lineHeight: 1.55 }}>{cap.description}</p>}
      {cap.secretRefs && cap.secretRefs.length > 0 && (
        <div className="small" style={{ color: "var(--ink-muted)" }}>
          Needs: {cap.secretRefs.map(s => (
            <a key={s} href={`/secrets?name=${encodeURIComponent(s)}`} className="mono" style={{ color: "var(--brand)" }} title={`Set ${s} in Secrets`}>{s} </a>
          ))}
        </div>
      )}
      <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--s2)", alignItems: "center", justifyContent: "space-between" }}>
        <SideEffectBadge effect={cap.sideEffect} gated={gated} />
        <button className="btn btn-ghost btn-sm" onClick={() => onView(cap)} style={{ padding: "0 var(--s2)" }}>View source</button>
      </div>
      {isPlugin && (
        <div style={{ display: "flex", gap: "var(--s2)", marginTop: "auto", paddingTop: "var(--s3)", borderTop: "1px solid var(--line)", flexWrap: "wrap" }}>
          {(cap.status === "disabled" || cap.status === "installed") && <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => act(() => enableCapability(cap.name), `${cap.name} enabled`)}>Enable</button>}
          {cap.status === "enabled" && <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => act(() => disableCapability(cap.name), `${cap.name} disabled`)}>Disable</button>}
          {!confirmDel ? <button className="btn btn-danger btn-sm" onClick={() => setConfirmDel(true)}>Remove</button>
            : <button className="btn btn-danger btn-sm" disabled={busy} onClick={() => act(async () => { await uninstallCapability(cap.name); }, `${cap.name} removed`)}>{busy ? "…" : "Confirm"}</button>}
        </div>
      )}
    </div>
  );
}

// ── Connectors (MCP) subsection ──────────────────────────────────────────────
function Connectors({ servers, onChange, flash }: { servers: McpServerRecord[]; onChange: () => Promise<void>; flash: (m: string) => void }) {
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [argsText, setArgsText] = useState("");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function connect(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) { setErr("name is required"); return; }
    if (!command.trim() && !url.trim()) { setErr("provide a command (stdio) or a URL (HTTP/SSE)"); return; }
    setBusy(true); setErr(null);
    try {
      await connectMcpServer({
        name: name.trim(),
        command: command.trim() || undefined,
        args: argsText.trim() ? argsText.trim().split(/\s+/) : undefined,
        url: url.trim() || undefined,
      });
      setName(""); setCommand(""); setArgsText(""); setUrl(""); setShowForm(false);
      await onChange();
      flash(`${name.trim()} connected — its tools are now capabilities`);
    } catch (e2) { setErr((e2 as Error).message); }
    finally { setBusy(false); }
  }

  return (
    <Section title="Connectors" sub="MCP servers — connect a tool host and every tool it exposes becomes a capability">
      {/* connect actions: official servers live in Discover; custom servers connect here */}
      <div style={{ display: "flex", gap: "var(--s2)", marginBottom: "var(--s4)", flexWrap: "wrap" }}>
        <button className="btn btn-primary btn-sm" onClick={() => { setShowForm(s => !s); setErr(null); }}>
          {showForm ? "Cancel" : "+ Connect a custom server"}
        </button>
        <span className="small muted" style={{ alignSelf: "center" }}>
          Or install GitHub / Slack / Filesystem from the <b style={{ color: "var(--brand)" }}>Discover</b> tab.
        </span>
      </div>

      {showForm && (
        <form onSubmit={connect} className="card" style={{ padding: "var(--s5)", marginBottom: "var(--s4)", maxWidth: 640, display: "flex", flexDirection: "column", gap: "var(--s3)" }}>
          <p className="small soft" style={{ margin: 0 }}>
            Connect your own MCP server — by a launch <b>command</b> (stdio) or a <b>URL</b> (HTTP/SSE).
            Every tool it exposes becomes a capability your agents can use.
          </p>
          <div>
            <label className="label">Name</label>
            <input className="input" value={name} onChange={e => setName(e.target.value)} placeholder="my-server" />
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--s3)" }}>
            <div>
              <label className="label">Command (stdio)</label>
              <input className="input input-mono" value={command} onChange={e => setCommand(e.target.value)} placeholder="npx" />
            </div>
            <div>
              <label className="label">Args</label>
              <input className="input input-mono" value={argsText} onChange={e => setArgsText(e.target.value)} placeholder="-y @scope/server" />
            </div>
          </div>
          <div>
            <label className="label">…or URL (HTTP/SSE)</label>
            <input className="input input-mono" value={url} onChange={e => setUrl(e.target.value)} placeholder="https://my-mcp-server.example.com/sse" />
          </div>
          {err && <div className="state-error">{err}</div>}
          <div style={{ display: "flex", gap: "var(--s2)" }}>
            <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>{busy ? "Connecting…" : "Connect"}</button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setShowForm(false)}>Cancel</button>
          </div>
        </form>
      )}

      {servers.length === 0 ? (
        <div className="state-empty" style={{ padding: "var(--s7) var(--s6)" }}>
          <span className="glyph-chip" style={{ width: 36, height: 36, color: "var(--brand)" }}><Glyph d={ICON.plug} size={18} /></span>
          <p className="h3" style={{ color: "var(--ink)", margin: "var(--s2) 0 0" }}>No connectors yet</p>
          <p className="small soft" style={{ maxWidth: "40ch", margin: "0 auto var(--s2)" }}>Use <b>+ Connect a custom server</b> above, or install GitHub / Slack / Filesystem from the Discover tab. Every tool the server exposes shows up here as a capability.</p>
        </div>
      ) : (
        <div className="cap-grid">
          {servers.map(s => (
            <div key={s.name} className="card cap-card">
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "var(--s2)" }}>
                <div className="h3 mono" style={{ color: "var(--ink)" }}>{s.name}</div>
                <span className={`badge ${s.connected ? "badge-done" : "badge-failed"}`}>{s.connected && <span className="dot" />}{s.connected ? "connected" : "error"}</span>
              </div>
              <div className="small muted"><span className="mono">{s.tools.length}</span> tools exposed</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
                {s.tools.slice(0, 6).map(t => <span key={t} className="mono" style={{ fontSize: 13, padding: "2px var(--s2)", background: "var(--surface-sunken)", color: "var(--ink-soft)", borderRadius: "var(--r-pill)" }}>{t}</span>)}
                {s.tools.length > 6 && <span className="small muted">+{s.tools.length - 6}</span>}
              </div>
              <div style={{ marginTop: "auto", paddingTop: "var(--s3)", borderTop: "1px solid var(--line)" }}>
                <button className="btn btn-danger btn-sm" onClick={() => { void disconnectMcpServer(s.name).then(onChange).then(() => flash(`${s.name} disconnected`)); }}>Disconnect</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}

// ── Discover tab (marketplace) ───────────────────────────────────────────────
function DiscoverTab({ catalog, q, installedNames, onInstalled, flash }: { catalog: CatalogEntry[]; q: string; installedNames: Set<string>; onInstalled: () => Promise<void>; flash: (m: string) => void }) {
  const items = catalog.filter(e => !q || `${e.name} ${e.title} ${e.oneLiner} ${e.category}`.toLowerCase().includes(q));
  // Templates (whole installable agents) lead the marketplace — that's the headline.
  const templates = items.filter(e => e.kind === "template");
  const official = items.filter(e => e.kind !== "template" && e.tier === "official");
  const community = items.filter(e => e.kind !== "template" && e.tier === "community");
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--s7)" }}>
      {templates.length > 0 && (
        <Section title="Agent templates" sub="A whole working agent in one click — graph, capabilities, and a signed record of every run">
          <div className="cap-grid">{templates.map(e => <CatalogCard key={e.name} e={e} installed={false} onInstalled={onInstalled} flash={flash} />)}</div>
        </Section>
      )}
      <Section title="Official" sub="Signed by Krelvan — install with one click">
        <div className="cap-grid">{official.map(e => <CatalogCard key={e.name} e={e} installed={installedNames.has(e.name)} onInstalled={onInstalled} flash={flash} />)}</div>
      </Section>
      <Section title="Community" sub="Unsigned — review before you install">
        <div className="cap-grid">{community.map(e => <CatalogCard key={e.name} e={e} installed={installedNames.has(e.name)} onInstalled={onInstalled} flash={flash} />)}</div>
      </Section>
    </div>
  );
}

function CatalogCard({ e, installed, onInstalled, flash }: { e: CatalogEntry; installed: boolean; onInstalled: () => Promise<void>; flash: (m: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [ack, setAck] = useState(false);
  const needAck = e.tier === "community" && !ack;
  async function install() {
    setBusy(true);
    try {
      if (e.kind === "template" && e.manifest) {
        const res = await installTemplate({ manifest: e.manifest, capabilities: e.capabilities ?? [], secretRefs: e.secretRefs ?? [] });
        await onInstalled();
        if (res.missingSecrets.length > 0) {
          flash(`${e.title} installed — set ${res.missingSecrets.length} secret${res.missingSecrets.length > 1 ? "s" : ""} to finish`);
          // Route to secrets, pre-filling the first one; the Secrets page lists the rest.
          window.location.href = `/secrets?name=${encodeURIComponent(res.missingSecrets[0]!)}`;
        } else {
          flash(`${e.title} installed — opening the agent`);
          window.location.href = `/canvas/${encodeURIComponent(res.agent.id)}`;
        }
        return;
      }
      if (e.kind === "mcp" && e.mcp) { await connectMcpServer({ ...e.mcp, name: e.mcp.name ?? e.name }); }
      else if (e.kind === "yaml" && e.yaml) { await installCapability(e.name, e.yaml); }
      await onInstalled(); flash(`${e.title} installed`);
    } catch (err) { flash((err as Error).message); } finally { setBusy(false); }
  }
  return (
    <div className="card cap-card">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "var(--s2)" }}>
        <div className="h3" style={{ color: "var(--ink)" }}>{e.title}</div>
        {e.tier === "official"
          ? <span className="badge badge-done"><span style={{ display: "inline-flex", color: "var(--ok)" }}><Glyph d={ICON.shield} size={11} /></span>official</span>
          : <span className="badge badge-neutral">community</span>}
      </div>
      <p className="small" style={{ color: "var(--ink-soft)", margin: 0, lineHeight: 1.55 }}>{e.oneLiner}</p>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--s2)", alignItems: "center" }}>
        <SideEffectBadge effect={e.sideEffect} />
        <span className="mono small" style={{ color: "var(--ink-muted)" }}>{e.kind === "mcp" ? "connector" : e.kind === "template" ? "agent" : "YAML"}</span>
        {e.kind === "template" && e.capabilities && e.capabilities.length > 0 && (
          <span className="badge badge-neutral" title="Capabilities this agent installs">{e.capabilities.length} tools</span>
        )}
        {e.price
          ? <span className="badge badge-neutral" style={{ color: "var(--ink)" }}>{e.price}</span>
          : <span className="badge badge-done">free</span>}
      </div>
      {e.secretRefs && e.secretRefs.length > 0 && (
        <div className="small" style={{ color: "var(--ink-muted)" }}>Needs: {e.secretRefs.map(s => (
          <a key={s} href={`/secrets?name=${encodeURIComponent(s)}`} className="mono" style={{ color: "var(--brand)" }} title={`Set ${s} in Secrets`}>{s} </a>
        ))}</div>
      )}
      <div style={{ marginTop: "auto", paddingTop: "var(--s3)", borderTop: "1px solid var(--line)" }}>
        {installed ? (
          <span className="small" style={{ color: "var(--ok)", display: "inline-flex", alignItems: "center", gap: 5 }}><Glyph d={ICON.check} size={13} />Installed</span>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--s2)" }}>
            {e.tier === "community" && (
              <label className="small" style={{ display: "flex", alignItems: "center", gap: "var(--s2)", color: "var(--ink-soft)", cursor: "pointer" }}>
                <input type="checkbox" checked={ack} onChange={ev => setAck(ev.target.checked)} /> I understand the risks
              </label>
            )}
            <button className="btn btn-primary btn-sm" disabled={busy || needAck} onClick={install} style={{ alignSelf: "flex-start" }}>
              {busy ? "Installing…" : e.kind === "mcp" ? "Connect" : e.kind === "template" ? "Install agent" : "Install"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
