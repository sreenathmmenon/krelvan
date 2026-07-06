"use client";
import { useState, useEffect, useMemo, useCallback } from "react";
import {
  listCapabilities, installCapability, installCapabilityFile, installTemplate, customizeTemplate,
  enableCapability, disableCapability, uninstallCapability,
  listMcpServers, connectMcpServer, disconnectMcpServer,
  getCapabilitySource, updateCapabilityYaml, setSecret,
  type CapabilityRecord, type McpServerRecord,
} from "../../lib/api";
import { loadRegistry, type CatalogEntry } from "../../lib/registry";
import { sideEffectMeta, toneColors, needsApproval, type Autonomy } from "../../lib/sideEffects";
import { glyphFor, UI } from "../../lib/glyphs";

// ── Capabilities — "what your agents can do" ─────────────────────────────────
// The flagship marketplace. Two tabs: DISCOVER (browse + install, the wow) and
// INSTALLED (control panel). Research-backed (Raycast Store + Glama): icon-led
// cards, kind facets + category chips + sort, a per-item detail drawer, one-click
// install with INLINE secret setup, and "add your own". Krelvan's wedge — the
// side-effect/permission model — is on every card and in the
// approval simulator (no other marketplace can show what a tool can touch).

// ── SVG glyph helper ─────────────────────────────────────────────────────────
function Icon({ d, size = 16, sw = 1.3 }: { d: string; size?: number; sw?: number }) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} fill="none" aria-hidden="true" style={{ display: "block" }}>
      <path d={d} stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
/** Square, tinted icon tile — the per-capability "face" that makes 40 connectors distinct. */
function IconTile({ name, category, kind, size = 40 }: { name: string; category?: string; kind?: string; size?: number }) {
  return (
    <span className="cap-icon" style={{ width: size, height: size }} aria-hidden="true">
      <Icon d={glyphFor(name, category, kind)} size={Math.round(size * 0.5)} sw={1.3} />
    </span>
  );
}

const AUTONOMY_OPTS: { key: Autonomy; label: string; hint: string }[] = [
  { key: "suggest",       label: "Suggest",       hint: "asks before every action" },
  { key: "act-with-veto", label: "Act-with-veto", hint: "asks before risky actions" },
  { key: "full",          label: "Full",          hint: "only asks to spend or change access" },
];

function SideEffectBadge({ effect, gated }: { effect: string; gated?: boolean }) {
  const m = sideEffectMeta(effect);
  const c = toneColors(m.tone);
  return (
    <span className="cap-se" style={{ background: c.bg, color: c.fg }}>
      {m.label}
      {gated && <span title="Pauses for your approval" className="cap-se__gate">pauses</span>}
    </span>
  );
}

// kind → human label for cards
function kindLabel(kind: string): string {
  return kind === "mcp" ? "Connector" : kind === "template" ? "Agent" : kind === "pack" ? "Pack" : "Capability";
}

// Normalize a provider / author / label for display (e.g. "community" → "Community",
// "marketplace" → "Marketplace", "ollama" → "Ollama"). Prose labels only — NEVER apply
// to the intentional mono data-pills (capability names / tool ids stay verbatim).
function displayLabel(s: string): string {
  if (!s) return s;
  const known: Record<string, string> = { ollama: "Ollama", openai: "OpenAI", anthropic: "Anthropic", mcp: "MCP" };
  const lower = s.toLowerCase();
  if (known[lower]) return known[lower]!;
  // Title-case a single lowercase word (community, marketplace); leave already-cased/multi-word alone.
  return /^[a-z][a-z0-9]*$/.test(s) ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

// Section order + copy for the grouped Discover grid (breaks the "wall of 60 cards").
const KIND_SECTIONS: { kind: string; label: string; blurb: string }[] = [
  { kind: "template", label: "Agents",       blurb: "whole agents you customize & install" },
  { kind: "mcp",      label: "Connectors",   blurb: "MCP servers you connect" },
  { kind: "yaml",     label: "Capabilities", blurb: "single tools you install" },
  { kind: "pack",     label: "Packs",        blurb: "curated bundles you open" },
];

export default function CapabilitiesPage() {
  const [tab, setTab] = useState<"discover" | "installed">("discover");
  const [caps, setCaps] = useState<CapabilityRecord[]>([]);
  const [servers, setServers] = useState<McpServerRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [autonomy, setAutonomy] = useState<Autonomy>("act-with-veto");
  const [query, setQuery] = useState("");
  const [toast, setToast] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [viewSource, setViewSource] = useState<CapabilityRecord | null>(null);
  const [detail, setDetail] = useState<CatalogEntry | null>(null);
  const [customizing, setCustomizing] = useState<CatalogEntry | null>(null);
  const [addOpen, setAddOpen] = useState(false);

  const reload = useCallback(async () => {
    setLoadErr(null);
    try {
      const [c, s] = await Promise.all([listCapabilities(), listMcpServers().catch(() => [])]);
      setCaps(c); setServers(s);
    } catch (e) {
      setLoadErr((e as Error).message || "could not load capabilities");
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { void reload(); }, [reload]);
  useEffect(() => {
    void loadRegistry().then(r => {
      setCatalog(r.entries);
      // Deep-link from the homepage gallery: /capabilities?install=<name> opens that item's
      // detail drawer so a visitor lands straight on "here's what it does + install".
      if (typeof window !== "undefined") {
        const want = new URLSearchParams(window.location.search).get("install");
        if (want) {
          const found = r.entries.find(e => e.name === want);
          if (found) { setTab("discover"); setDetail(found); }
        }
      }
    }).catch(() => {});
  }, []);

  function flash(msg: string) { setToast(msg); setTimeout(() => setToast(null), 3500); }

  const q = query.trim().toLowerCase();
  const installedNames = useMemo(() => new Set(caps.map(c => c.name).concat(servers.map(s => s.name))), [caps, servers]);

  const activeCount = caps.filter(c => c.kind === "builtin" || c.status === "enabled").length;

  return (
    <div className="container" style={{ paddingTop: "var(--s7)", paddingBottom: "var(--s9)" }}>
      {/* ── header ── */}
      <p className="micro" style={{ marginBottom: "var(--s3)" }}>An open, forkable catalog</p>
      <div className="cap-head">
        <div style={{ minWidth: 0 }}>
          <h1 className="h1" style={{ marginBottom: "var(--s2)" }}>Marketplace</h1>
          <p className="body-lg soft" style={{ margin: 0, maxWidth: "62ch" }}>
            Whole agents, connectors, and capabilities — install one in a click, clone and
            customize it for your own use, or publish your own. It&apos;s a plain, open catalog
            you can fork and host yourself: no gatekeeper, no lock-in.
          </p>
        </div>
        {/* Two clear, non-overlapping figures that match the tab counters exactly
            (Installed N / Discover N) — no ambiguous 'built-in' subset competing. */}
        <div className="cap-stats">
          <Stat value={String(activeCount)} label="installed & ready" />
          <Stat value={String(catalog.length)} label="in marketplace" />
        </div>
      </div>

      {/* ── side-effect spectrum + approval simulator (the trust wedge) ── */}
      {/* Marketplace items while browsing Discover (sells even with nothing installed); your
          installed capabilities on the Installed tab. */}
      <Spectrum
        caps={tab === "discover"
          ? catalog.map(e => ({ name: e.name, sideEffect: e.sideEffect }))
          : caps.map(c => ({ name: c.name, sideEffect: c.sideEffect }))}
        autonomy={autonomy} setAutonomy={setAutonomy}
        source={tab === "discover" ? "marketplace" : "installed"}
      />

      {/* ── tabs ── */}
      <div className="cap-tabs" role="tablist" aria-label="Capabilities views">
        <button role="tab" aria-selected={tab === "discover"} className="cap-tab" data-on={tab === "discover"} onClick={() => { setTab("discover"); setQuery(""); }}>
          Discover <span className="mono cap-tab__n">{catalog.length}</span>
        </button>
        <button role="tab" aria-selected={tab === "installed"} className="cap-tab" data-on={tab === "installed"} onClick={() => { setTab("installed"); setQuery(""); }}>
          Installed <span className="mono cap-tab__n">{caps.length + servers.length}</span>
        </button>
      </div>

      {tab === "discover" ? (
        <DiscoverTab
          catalog={catalog} q={q} query={query} setQuery={setQuery}
          installedNames={installedNames} autonomy={autonomy}
          onInstalled={reload} flash={flash} onDetail={setDetail} onCustomize={setCustomizing} onAdd={() => setAddOpen(true)}
        />
      ) : (
        <InstalledTab
          caps={caps} servers={servers} loading={loading} loadErr={loadErr}
          q={q} query={query} setQuery={setQuery} autonomy={autonomy}
          onChange={reload} onRetry={reload} flash={flash} onView={setViewSource} onAdd={() => setAddOpen(true)}
        />
      )}

      {toast && (
        <div role="status" className="cap-toast">
          <span className="cap-toast__mark" aria-hidden="true"><Icon d={UI.check} size={13} /></span>{toast}
        </div>
      )}

      {viewSource && <SourceDrawer cap={viewSource} onClose={() => setViewSource(null)} onSaved={reload} flash={flash} />}
      {detail && (
        <DetailDrawer
          e={detail} installed={installedNames.has(detail.name)} catalog={catalog}
          onClose={() => setDetail(null)} onInstalled={reload} flash={flash}
        />
      )}
      {customizing && (
        <CustomizeDrawer
          e={customizing} onClose={() => setCustomizing(null)} onInstalled={reload} flash={flash}
        />
      )}
      {addOpen && <AddOwnDrawer onClose={() => setAddOpen(false)} onInstalled={reload} flash={flash} />}
    </div>
  );
}

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div className="cap-stat">
      <div className="mono cap-stat__v">{value}</div>
      <div className="micro cap-stat__l">{label}</div>
    </div>
  );
}

// ── Spectrum band + live approval simulator ──────────────────────────────────
// Accepts any list of {name, sideEffect} — installed caps on the Installed tab, or the whole
// catalog on Discover (so the trust wedge SELLS exactly when a visitor is browsing, even with
// nothing installed yet). `source` just relabels the count copy.
type SpecItem = { name: string; sideEffect: string };
function Spectrum({ caps, autonomy, setAutonomy, source }: { caps: SpecItem[]; autonomy: Autonomy; setAutonomy: (a: Autonomy) => void; source: "installed" | "marketplace" }) {
  const [showAll, setShowAll] = useState(false);
  const buckets: Record<0 | 1 | 2, SpecItem[]> = { 0: [], 1: [], 2: [] };
  for (const c of caps) buckets[sideEffectMeta(c.sideEffect).tier].push(c);
  const gatedCount = caps.filter(c => needsApproval(autonomy, c.sideEffect)).length;
  const PER_ZONE = 8;
  const hiddenCount = caps.length - ([0, 1, 2] as const).reduce<number>((n, t) => n + Math.min(buckets[t].length, PER_ZONE), 0);

  return (
    <div className="cap-spectrum">
      <div className="cap-spectrum__row">
        <div className="cap-spectrum__head">
          <span className="micro" style={{ color: "var(--ink-soft)" }}>{source === "marketplace" ? "Every capability in the marketplace, by what it can touch" : "Every installed capability, by what it can do"}</span>
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

// ── search + add bar (shared) ────────────────────────────────────────────────
function SearchBar({ query, setQuery, placeholder, onAdd }: { query: string; setQuery: (s: string) => void; placeholder: string; onAdd: () => void }) {
  return (
    <div className="cap-toolbar">
      <div className="cap-search">
        <span className="cap-search__icon" style={{ color: "var(--ink-muted)" }}><Icon d={UI.search} /></span>
        <input className="input cap-search__input" type="search" placeholder={placeholder} value={query} onChange={e => setQuery(e.target.value)} aria-label="Search" />
      </div>
      <button className="btn btn-secondary btn-sm cap-add-btn" onClick={onAdd}>
        <Icon d={UI.plus} size={13} /> Add your own
      </button>
    </div>
  );
}

// ── DISCOVER tab (the marketplace) ───────────────────────────────────────────
type SortKey = "featured" | "az" | "kind";
const KIND_FACETS: { key: string; label: string; test: (e: CatalogEntry) => boolean }[] = [
  { key: "all", label: "All", test: () => true },
  { key: "template", label: "Agents", test: e => e.kind === "template" },
  { key: "mcp", label: "Connectors (MCP)", test: e => e.kind === "mcp" },
  { key: "yaml", label: "Capabilities", test: e => e.kind === "yaml" },
  { key: "pack", label: "Packs", test: e => e.kind === "pack" },
];

function DiscoverTab({ catalog, q, query, setQuery, installedNames, autonomy, onInstalled, flash, onDetail, onCustomize, onAdd }: {
  catalog: CatalogEntry[]; q: string; query: string; setQuery: (s: string) => void;
  installedNames: Set<string>; autonomy: Autonomy;
  onInstalled: () => Promise<void>; flash: (m: string) => void; onDetail: (e: CatalogEntry) => void; onCustomize: (e: CatalogEntry) => void; onAdd: () => void;
}) {
  const [kind, setKind] = useState("all");
  const [cat, setCat] = useState<string | null>(null);
  const [sort, setSort] = useState<SortKey>("featured");

  // category counts (within the current kind facet + search)
  const base = useMemo(() => catalog.filter(e =>
    (KIND_FACETS.find(f => f.key === kind)?.test(e) ?? true) &&
    (!q || `${e.name} ${e.title} ${e.oneLiner} ${e.category} ${e.author}`.toLowerCase().includes(q))
  ), [catalog, kind, q]);

  const categories = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of base) m.set(e.category, (m.get(e.category) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [base]);

  const items = useMemo(() => {
    let list = base.filter(e => !cat || e.category === cat);
    if (sort === "az") list = [...list].sort((a, b) => a.title.localeCompare(b.title));
    else if (sort === "kind") list = [...list].sort((a, b) => a.kind.localeCompare(b.kind) || a.title.localeCompare(b.title));
    else { // featured: templates → official → community, then A-Z
      const rank = (e: CatalogEntry) => (e.kind === "template" ? 0 : e.tier === "official" ? 1 : 2);
      list = [...list].sort((a, b) => rank(a) - rank(b) || a.title.localeCompare(b.title));
    }
    return list;
  }, [base, cat, sort]);

  // featured strip — 3 hero picks (templates first) shown only with no search/filter
  const featured = useMemo(() => catalog.filter(e => e.kind === "template").slice(0, 3), [catalog]);
  const showFeatured = !q && kind === "all" && !cat;

  // Group the grid by kind whenever the list spans multiple kinds and the user hasn't
  // pinned one kind or asked for a flat A-Z list — this is what dissolves the "wall".
  const grouped = kind === "all" && sort !== "az" && new Set(items.map(e => e.kind)).size > 1;

  return (
    <div className="cap-discover">
      <SearchBar query={query} setQuery={setQuery} placeholder={`Search ${catalog.length} connectors, agents & tools…`} onAdd={onAdd} />

      {showFeatured && featured.length > 0 && (
        <div className="cap-featured">
          <p className="micro" style={{ color: "var(--ink-soft)", marginBottom: "var(--s3)" }}>Featured — a whole agent in one click</p>
          <div className="cap-featured__grid">
            {featured.map(e => <FeaturedCard key={e.name} e={e} installed={installedNames.has(e.name)} onDetail={onDetail} />)}
          </div>
        </div>
      )}

      {/* kind facets */}
      <div className="cap-facets" role="tablist" aria-label="Filter by type">
        <span className="cap-axis-label micro" aria-hidden="true">Type</span>
        {KIND_FACETS.map(f => {
          const n = catalog.filter(e => f.test(e) && (!q || `${e.name} ${e.title} ${e.oneLiner} ${e.category}`.toLowerCase().includes(q))).length;
          if (f.key !== "all" && n === 0) return null;
          return (
            <button key={f.key} className="cap-facet" data-on={kind === f.key} onClick={() => { setKind(f.key); setCat(null); }}>
              {f.label} <span className="cap-facet__n">{n}</span>
            </button>
          );
        })}
        <div className="cap-sort">
          <label className="micro" style={{ color: "var(--ink-muted)" }}>Sort</label>
          <select className="cap-sort__sel" value={sort} onChange={e => setSort(e.target.value as SortKey)} aria-label="Sort">
            <option value="featured">Featured</option>
            <option value="az">A–Z</option>
            <option value="kind">By type</option>
          </select>
        </div>
      </div>

      {/* category chips */}
      {categories.length > 1 && (
        <div className="cap-chips">
          <span className="cap-axis-label micro" aria-hidden="true">Category</span>
          <button className="cap-chip" data-on={!cat} onClick={() => setCat(null)}>All categories <span className="cap-chip__n">{base.length}</span></button>
          {categories.map(([c, n]) => (
            <button key={c} className="cap-chip" data-on={cat === c} onClick={() => setCat(cat === c ? null : c)}>{c} <span className="cap-chip__n">{n}</span></button>
          ))}
        </div>
      )}

      {/* legend — makes the per-kind CTA verbs read as intentional, not random */}
      {items.length > 0 && (
        <p className="cap-legend small muted">
          Cards are labelled by type: <b style={{ color: "var(--ink-soft)" }}>Agents</b> install,{" "}
          <b style={{ color: "var(--ink-soft)" }}>Connectors</b> connect,{" "}
          <b style={{ color: "var(--ink-soft)" }}>Capabilities</b> install,{" "}
          <b style={{ color: "var(--ink-soft)" }}>Packs</b> open a bundle.
        </p>
      )}

      {/* the grid */}
      {items.length === 0 ? (
        <div className="state-empty" style={{ padding: "var(--s8) var(--s6)" }}>
          <span className="glyph-chip" style={{ width: 36, height: 36, color: "var(--brand)" }}><Icon d={UI.search} size={18} /></span>
          <p className="h3" style={{ color: "var(--ink)", margin: "var(--s2) 0 0" }}>Nothing matches</p>
          <p className="small soft" style={{ maxWidth: "40ch", margin: "0 auto" }}>Try a different search or clear the filters. Can&apos;t find it? <button className="btn-link" onClick={onAdd}>Add your own</button>.</p>
        </div>
      ) : grouped ? (
        // Grouped view — the wall of ~60 cards breaks into scannable, headed sections by
        // kind. Only when no single kind is pinned and sort isn't A-Z (which is meant flat).
        <div className="cap-groups">
          {KIND_SECTIONS.map(sec => {
            const rows = items.filter(e => e.kind === sec.kind);
            if (rows.length === 0) return null;
            return (
              <section key={sec.kind} className="cap-group">
                <div className="cap-group__head">
                  <span className="micro" style={{ color: "var(--ink)" }}>{sec.label}</span>
                  <span className="cap-group__n mono">{rows.length}</span>
                  <span className="small muted cap-group__blurb">{sec.blurb}</span>
                </div>
                <div className="cap-grid">
                  {rows.map(e => (
                    <CatalogCard key={e.name} e={e} installed={installedNames.has(e.name)} autonomy={autonomy} onInstalled={onInstalled} flash={flash} onDetail={onDetail} onCustomize={onCustomize} />
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      ) : (
        <div className="cap-grid">
          {items.map(e => (
            <CatalogCard key={e.name} e={e} installed={installedNames.has(e.name)} autonomy={autonomy} onInstalled={onInstalled} flash={flash} onDetail={onDetail} onCustomize={onCustomize} />
          ))}
        </div>
      )}
    </div>
  );
}

function FeaturedCard({ e, installed, onDetail }: { e: CatalogEntry; installed: boolean; onDetail: (e: CatalogEntry) => void }) {
  return (
    <button className="cap-feat" onClick={() => onDetail(e)}>
      <IconTile name={e.name} category={e.category} kind={e.kind} size={44} />
      <div style={{ minWidth: 0, textAlign: "left" }}>
        <div className="cap-feat__title">{e.title}{installed && <span className="cap-feat__inst" title="Installed"><Icon d={UI.check} size={11} /></span>}</div>
        <div className="cap-feat__sub small soft">{e.oneLiner}</div>
      </div>
    </button>
  );
}

function CatalogCard({ e, installed, autonomy, onInstalled, flash, onDetail, onCustomize }: {
  e: CatalogEntry; installed: boolean; autonomy: Autonomy; onInstalled: () => Promise<void>; flash: (m: string) => void; onDetail: (e: CatalogEntry) => void; onCustomize: (e: CatalogEntry) => void;
}) {
  const [busy, setBusy] = useState(false);
  const gated = needsApproval(autonomy, e.sideEffect);
  const toolCount = e.kind === "mcp" ? (e.mcp?.tools?.length ?? 0) : (e.capabilities?.length ?? 0);
  const customizable = e.kind === "template" && !!e.manifest?.customize && Object.keys(e.manifest.customize).length > 0;

  async function quickInstall(ev: React.MouseEvent) {
    ev.stopPropagation();
    // A customizable template opens the "make it mine" form first: name it, point it at
    // your knowledge base, set the tone — the clone-and-customize flow.
    if (customizable) { onCustomize(e); return; }
    // Community items + anything needing secrets go through the detail drawer (review first).
    if (e.tier === "community" || (e.secretRefs && e.secretRefs.length > 0) || e.kind === "pack") { onDetail(e); return; }
    setBusy(true);
    try {
      if (e.kind === "template" && e.manifest) {
        const res = await installTemplate({ manifest: e.manifest, capabilities: e.capabilities ?? [], secretRefs: e.secretRefs ?? [] });
        await onInstalled();
        if (res.missingSecrets.length > 0) { onDetail(e); }
        else { flash(`${e.title} installed`); window.location.href = `/canvas/${encodeURIComponent(res.agent.id)}`; }
        return;
      }
      if (e.kind === "mcp" && e.mcp) await connectMcpServer({ ...e.mcp, name: e.mcp.name ?? e.name });
      else if (e.kind === "yaml" && e.yaml) await installCapability(e.name, e.yaml);
      await onInstalled(); flash(`${e.title} installed`);
    } catch (err) { flash((err as Error).message); } finally { setBusy(false); }
  }

  // Install a customizable template with its defaults, skipping the customize form — the
  // secondary "plain Install" path beside the prominent "Customize & install" CTA.
  async function installAsIs(ev: React.MouseEvent) {
    ev.stopPropagation();
    if (e.tier === "community" || (e.secretRefs && e.secretRefs.length > 0)) { onDetail(e); return; }
    setBusy(true);
    try {
      if (e.kind === "template" && e.manifest) {
        const res = await installTemplate({ manifest: e.manifest, capabilities: e.capabilities ?? [], secretRefs: e.secretRefs ?? [] });
        await onInstalled();
        if (res.missingSecrets.length > 0) { onDetail(e); }
        else { flash(`${e.title} installed`); window.location.href = `/canvas/${encodeURIComponent(res.agent.id)}`; }
      }
    } catch (err) { flash((err as Error).message); } finally { setBusy(false); }
  }

  return (
    <div className="card cap-card cap-card--clk" onClick={() => onDetail(e)} role="button" tabIndex={0}
      onKeyDown={ev => { if (ev.key === "Enter") onDetail(e); }}>
      <div className="cap-card__top">
        <IconTile name={e.name} category={e.category} kind={e.kind} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="cap-card__title">{e.title}</div>
          <div className="cap-card__meta small muted" style={{ display: "flex", alignItems: "center", gap: "var(--s2)", flexWrap: "wrap" }}>
            <span className="cap-kind">{kindLabel(e.kind)}</span>
            {e.author && e.author !== "Krelvan" ? <span>· {displayLabel(e.author)}</span> : null}
          </div>
        </div>
        {e.tier === "official"
          ? <span className="badge badge-done cap-badge"><span style={{ display: "inline-flex", color: "var(--ok)" }}><Icon d={UI.shield} size={10} /></span>official</span>
          : <span className="badge badge-neutral cap-badge">community</span>}
      </div>
      <p className="small cap-card__desc">{e.oneLiner}</p>
      <div className="cap-card__tags">
        <SideEffectBadge effect={e.sideEffect} gated={gated} />
        {toolCount > 0 && <span className="cap-tag mono">{toolCount} {e.kind === "mcp" ? "tools" : "caps"}</span>}
        {e.secretRefs && e.secretRefs.length > 0 && <span className="cap-tag">needs key</span>}
        {e.price ? <span className="cap-tag">{e.price}</span> : <span className="cap-tag cap-tag--free">free</span>}
      </div>
      <div className="cap-card__foot">
        {installed ? (
          <span className="cap-installed"><Icon d={UI.check} size={13} />Installed</span>
        ) : customizable ? (
          // Agent template: "Customize & install" is the prominent, default CTA; plain
          // "Install" (defaults, skip the form) sits beside it as the secondary path.
          <span style={{ display: "inline-flex", gap: "var(--s2)", alignItems: "center", flexWrap: "wrap" }}>
            <button className="btn btn-primary btn-sm" disabled={busy} onClick={quickInstall}>
              {busy ? "Installing…" : "Customize & install"}
            </button>
            <button className="btn btn-secondary btn-sm" disabled={busy} onClick={installAsIs} title="Install with the template's defaults — customize later on the canvas">
              Install
            </button>
          </span>
        ) : (
          <button className="btn btn-primary btn-sm" disabled={busy} onClick={quickInstall}>
            {busy ? "Installing…" : e.kind === "mcp" ? "Connect" : e.kind === "template" ? "Install agent" : e.kind === "pack" ? "View pack" : "Install"}
          </button>
        )}
        <span className="cap-card__more small muted">Details <Icon d={UI.chevron} size={11} /></span>
      </div>
    </div>
  );
}

// ── Detail drawer (per-capability) ───────────────────────────────────────────
function DetailDrawer({ e, installed, catalog, onClose, onInstalled, flash }: {
  catalog: CatalogEntry[];
  e: CatalogEntry; installed: boolean; onClose: () => void; onInstalled: () => Promise<void>; flash: (m: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [ack, setAck] = useState(false);
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [done, setDone] = useState(false);
  const needAck = e.tier === "community" && !ack;
  const needsSecrets = (e.secretRefs?.length ?? 0) > 0;
  const tools = e.kind === "mcp" ? (e.mcp?.tools ?? []) : [];
  const bundled = e.capabilities ?? [];

  useEffect(() => {
    function onKey(ev: KeyboardEvent) { if (ev.key === "Escape") onClose(); }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function install() {
    setBusy(true);
    try {
      // Set any provided secrets inline first (no bouncing to /secrets).
      for (const [k, v] of Object.entries(secrets)) {
        if (v.trim()) await setSecret(k, v.trim());
      }
      if (e.kind === "template" && e.manifest) {
        const res = await installTemplate({ manifest: e.manifest, capabilities: bundled, secretRefs: e.secretRefs ?? [] });
        await onInstalled();
        const stillMissing = res.missingSecrets.filter(s => !secrets[s]?.trim());
        if (stillMissing.length > 0) { flash(`${e.title} installed — ${stillMissing.length} secret(s) still needed`); setDone(true); }
        else { flash(`${e.title} installed`); window.location.href = `/canvas/${encodeURIComponent(res.agent.id)}`; }
        return;
      }
      if (e.kind === "mcp" && e.mcp) { await connectMcpServer({ ...e.mcp, name: e.mcp.name ?? e.name }); await onInstalled(); flash(`${e.title} installed`); setDone(true); return; }
      if (e.kind === "yaml" && e.yaml) { await installCapability(e.name, e.yaml); await onInstalled(); flash(`${e.title} installed`); setDone(true); return; }
      if (e.kind === "pack" && e.connectors) {
        // REAL pack install: resolve each named connector from the catalog and install it.
        // Only the ones with no required secrets install cleanly here; the rest are reported.
        let ok = 0; const needKey: string[] = []; const missing: string[] = [];
        for (const name of e.connectors) {
          const c = catalog.find(x => x.name === name);
          if (!c) { missing.push(name); continue; }
          if (c.secretRefs && c.secretRefs.length > 0) { needKey.push(name); continue; }
          try {
            if (c.kind === "mcp" && c.mcp) await connectMcpServer({ ...c.mcp, name: c.mcp.name ?? c.name });
            else if (c.kind === "yaml" && c.yaml) await installCapability(c.name, c.yaml);
            ok++;
          } catch { needKey.push(name); }
        }
        await onInstalled();
        const parts = [`installed ${ok}`];
        if (needKey.length) parts.push(`${needKey.length} need a key (open each from Discover)`);
        if (missing.length) parts.push(`${missing.length} not found`);
        flash(`${e.title}: ${parts.join(" · ")}`);
        setDone(true);
        return;
      }
      await onInstalled(); flash(`${e.title} installed`); setDone(true);
    } catch (err) { flash((err as Error).message); } finally { setBusy(false); }
  }

  const m = sideEffectMeta(e.sideEffect);

  return (
    <>
      <button className="nav-scrim" aria-label="Close" onClick={onClose} style={{ inset: 0 }} />
      <aside className="cap-drawer cap-drawer--wide" role="dialog" aria-modal="true" aria-label={e.title}>
        <div className="cap-drawer__head">
          <div style={{ display: "flex", gap: "var(--s3)", alignItems: "center", minWidth: 0 }}>
            <IconTile name={e.name} category={e.category} kind={e.kind} size={44} />
            <div style={{ minWidth: 0 }}>
              <div className="h3 text-truncate" style={{ color: "var(--ink)" }}>{e.title}</div>
              <div className="small muted">{kindLabel(e.kind)} · {e.category}{e.author ? <> · {displayLabel(e.author)}</> : null}</div>
            </div>
          </div>
          <button className="btn btn-ghost btn-sm cap-drawer__x" onClick={onClose} aria-label="Close"><Icon d={UI.close} size={14} /></button>
        </div>
        <div className="cap-drawer__body">
          <p className="body soft" style={{ marginBottom: "var(--s5)", lineHeight: 1.6 }}>{e.oneLiner}</p>

          {/* trust / permission panel — the wedge */}
          <div className="cap-perm">
            <div className="cap-perm__row">
              <span className="micro" style={{ color: "var(--ink-muted)" }}>What it can touch</span>
              <SideEffectBadge effect={e.sideEffect} />
            </div>
            <div className="cap-perm__row">
              <span className="micro" style={{ color: "var(--ink-muted)" }}>Trust</span>
              {e.tier === "official"
                ? <span className="small" style={{ color: "var(--ok)", display: "inline-flex", gap: 5, alignItems: "center" }}><Icon d={UI.shield} size={12} />Official Krelvan agent</span>
                : <span className="small" style={{ color: "var(--ink-soft)" }}>Community — review before installing</span>}
            </div>
            {m.tier >= 1 && (
              <div className="cap-perm__row">
                <span className="micro" style={{ color: "var(--ink-muted)" }}>Approval</span>
                <span className="small soft">Pauses for you at <b>Suggest</b>{m.tier === 2 ? " and Act-with-veto" : ""}</span>
              </div>
            )}
            {e.recommendedModel && (
              <div className="cap-perm__row">
                <span className="micro" style={{ color: "var(--ink-muted)" }}>Recommended model</span>
                <span className="small soft">{e.recommendedModel}</span>
              </div>
            )}
          </div>

          {/* MCP tool list / template capability list */}
          {tools.length > 0 && (
            <Block title={`${tools.length} tools exposed`}>
              <div className="cap-toollist">{tools.map(t => <span key={t} className="cap-tool mono">{t}</span>)}</div>
            </Block>
          )}
          {bundled.length > 0 && (
            <Block title={`Installs ${bundled.length} capabilit${bundled.length === 1 ? "y" : "ies"}`}>
              <div className="cap-toollist">{bundled.map(c => <span key={c.name} className="cap-tool mono">{c.name}</span>)}</div>
            </Block>
          )}
          {e.kind === "pack" && e.connectors && (
            <Block title={`Bundles ${e.connectors.length} connectors`}>
              <div className="cap-toollist">{e.connectors.map(c => <span key={c} className="cap-tool mono">{c}</span>)}</div>
            </Block>
          )}

          {/* inline secret setup */}
          {needsSecrets && !installed && (
            <Block title="Set up its keys">
              <p className="small soft" style={{ margin: "0 0 var(--s3)" }}>Paste the secrets this needs — they&apos;re stored encrypted, never shown again. You can also do this later in Secrets.</p>
              {e.secretRefs!.map(s => (
                <div key={s} style={{ marginBottom: "var(--s3)" }}>
                  <label className="label mono" style={{ fontSize: 12 }}>{s}</label>
                  <input className="input input-mono" type="password" placeholder={`value for ${s}`} value={secrets[s] ?? ""} onChange={ev => setSecrets(p => ({ ...p, [s]: ev.target.value }))} />
                </div>
              ))}
            </Block>
          )}

          {/* source link */}
          {e.sourceUrl && (
            <a href={e.sourceUrl} target="_blank" rel="noreferrer" className="cap-srclink small">
              View source <Icon d={UI.external} size={12} />
            </a>
          )}
        </div>

        {/* sticky footer action */}
        <div className="cap-drawer__foot">
          {installed || done ? (
            <span className="cap-installed" style={{ fontSize: 14 }}><Icon d={UI.check} size={15} />Installed</span>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: "var(--s2)", width: "100%" }}>
              {e.tier === "community" && (
                <label className="small cap-ack">
                  <input type="checkbox" checked={ack} onChange={ev => setAck(ev.target.checked)} /> I&apos;ve reviewed this community item and understand the risks
                </label>
              )}
              <button className="btn btn-primary cap-install-cta" disabled={busy || needAck} onClick={install}>
                {busy ? "Installing…" : e.kind === "mcp" ? "Connect" : e.kind === "template" ? "Install agent" : e.kind === "pack" ? "Install pack" : "Install"}
              </button>
            </div>
          )}
        </div>
      </aside>
    </>
  );
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="cap-block">
      <p className="micro" style={{ color: "var(--ink)", marginBottom: "var(--s3)" }}>{title}</p>
      {children}
    </div>
  );
}

// ── "Add your own" drawer (manual install: YAML / JS / MCP) ───────────────────
/**
 * The "make it mine" form — the clone-and-customize flow. Renders the template's
 * declared customize knobs (rename / knowledge base / tone / autonomy toggles) as a
 * small form, prefilled with the template's defaults, and creates the builder's own
 * named agent via POST /api/templates/customize. Empty text fields are omitted so the
 * template's own values stand; the server rejects anything not declared customizable.
 */
function CustomizeDrawer({ e, onClose, onInstalled, flash }: {
  e: CatalogEntry; onClose: () => void; onInstalled: () => Promise<void>; flash: (m: string) => void;
}) {
  const fields = useMemo(() => Object.entries(e.manifest?.customize ?? {}), [e]);
  const [values, setValues] = useState<Record<string, string | boolean>>(() => {
    const v: Record<string, string | boolean> = {};
    for (const [key, f] of Object.entries(e.manifest?.customize ?? {})) {
      if (f.type === "toggle") v[key] = f.default === true;
      else if (f.default !== undefined) v[key] = String(f.default);
      else if (f.type === "choice" && f.options?.length) v[key] = f.options[0]!;
      else v[key] = "";
    }
    return v;
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => { if (ev.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function submit() {
    setBusy(true); setErr(null);
    try {
      const settings: Record<string, string | boolean> = {};
      for (const [key, f] of fields) {
        const val = values[key];
        if (f.type === "toggle") settings[key] = val === true;
        else if (typeof val === "string" && val.trim()) settings[key] = val.trim();
        // empty text -> omitted; the template's own value stands
      }
      const res = await customizeTemplate({
        manifest: e.manifest, settings,
        capabilities: e.capabilities ?? [], secretRefs: e.secretRefs ?? [],
      });
      await onInstalled();
      const renameField = fields.find(([, f]) => f.rename);
      const agentName = (renameField && typeof values[renameField[0]] === "string" && (values[renameField[0]] as string).trim()) || e.title;
      flash(res.missingSecrets.length > 0 ? `${agentName} created — add its keys in Secrets` : `${agentName} created`);
      window.location.href = `/canvas/${encodeURIComponent(res.agent.id)}`;
    } catch (ex) { setErr((ex as Error).message); } finally { setBusy(false); }
  }

  return (
    <>
      <button className="nav-scrim" aria-label="Close" onClick={onClose} style={{ inset: 0 }} />
      <aside className="cap-drawer" role="dialog" aria-modal="true" aria-label={`Customize ${e.title}`}>
        <div className="cap-drawer__head">
          <div style={{ minWidth: 0 }}>
            <div className="cap-card__title">Make it yours</div>
            <p className="small muted" style={{ margin: "4px 0 0" }}>
              {e.title} — set the basics; everything else can be edited on the canvas after.
            </p>
          </div>
          <button className="btn btn-ghost btn-sm" onClick={onClose} aria-label="Close"><Icon d={UI.close} size={14} /></button>
        </div>
        <div style={{ padding: "var(--s5)", display: "grid", gap: "var(--s4)", overflowY: "auto" }}>
          {fields.map(([key, f]) => (
            <div key={key}>
              <label className="label" htmlFor={`cz-${key}`}>{f.label}</label>
              {f.type === "text" && (
                <input id={`cz-${key}`} className="input" value={String(values[key] ?? "")}
                  placeholder={f.default !== undefined ? String(f.default) : ""}
                  onChange={ev => setValues(p => ({ ...p, [key]: ev.target.value }))} />
              )}
              {f.type === "choice" && (
                <select id={`cz-${key}`} className="input" value={String(values[key] ?? "")}
                  onChange={ev => setValues(p => ({ ...p, [key]: ev.target.value }))}>
                  {(f.options ?? []).map(o => <option key={o} value={o}>{o}</option>)}
                </select>
              )}
              {f.type === "toggle" && (
                <label className="small" style={{ display: "flex", alignItems: "center", gap: "var(--s2)", cursor: "pointer" }}>
                  <input id={`cz-${key}`} type="checkbox" checked={values[key] === true}
                    onChange={ev => setValues(p => ({ ...p, [key]: ev.target.checked }))} />
                  <span className="muted">{values[key] === true ? "On" : "Off"}</span>
                </label>
              )}
            </div>
          ))}
          {err && <p className="small" style={{ color: "var(--danger)", margin: 0 }}>{err}</p>}
          <div style={{ display: "flex", gap: "var(--s3)", alignItems: "center" }}>
            <button className="btn btn-primary" disabled={busy} onClick={submit}>
              {busy ? "Creating…" : "Create my agent"}
            </button>
            <span className="micro muted">Installs as your own private agent</span>
          </div>
        </div>
      </aside>
    </>
  );
}

function AddOwnDrawer({ onClose, onInstalled, flash }: { onClose: () => void; onInstalled: () => Promise<void>; flash: (m: string) => void }) {
  const [mode, setMode] = useState<"yaml" | "file" | "mcp">("yaml");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // yaml
  const [yamlName, setYamlName] = useState("");
  const [yaml, setYaml] = useState("");
  // file
  const [file, setFile] = useState<File | null>(null);
  // mcp
  const [name, setName] = useState(""); const [command, setCommand] = useState(""); const [argsText, setArgsText] = useState(""); const [url, setUrl] = useState("");

  useEffect(() => {
    function onKey(ev: KeyboardEvent) { if (ev.key === "Escape") onClose(); }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function submit() {
    setBusy(true); setErr(null);
    try {
      if (mode === "yaml") {
        if (!yamlName.trim() || !yaml.trim()) throw new Error("name and YAML are required");
        await installCapability(yamlName.trim(), yaml);
        flash(`${yamlName.trim()} installed`);
      } else if (mode === "file") {
        if (!file) throw new Error("choose a .js or .ts plugin file");
        await installCapabilityFile(file);
        flash(`${file.name} installed`);
      } else {
        if (!name.trim()) throw new Error("name is required");
        if (!command.trim() && !url.trim()) throw new Error("provide a command (stdio) or a URL (HTTP/SSE)");
        await connectMcpServer({ name: name.trim(), command: command.trim() || undefined, args: argsText.trim() ? argsText.trim().split(/\s+/) : undefined, url: url.trim() || undefined });
        flash(`${name.trim()} connected`);
      }
      await onInstalled(); onClose();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }

  return (
    <>
      <button className="nav-scrim" aria-label="Close" onClick={onClose} style={{ inset: 0 }} />
      <aside className="cap-drawer cap-drawer--wide" role="dialog" aria-modal="true" aria-label="Add your own capability">
        <div className="cap-drawer__head">
          <div style={{ minWidth: 0 }}>
            <div className="h3" style={{ color: "var(--ink)" }}>Add your own</div>
            <div className="small muted">Bring a capability the marketplace doesn&apos;t have yet</div>
          </div>
          <button className="btn btn-ghost btn-sm cap-drawer__x" onClick={onClose} aria-label="Close"><Icon d={UI.close} size={14} /></button>
        </div>
        <div className="cap-drawer__body">
          <div className="cap-segment" role="tablist">
            {([["yaml", "Paste YAML"], ["file", "Upload plugin"], ["mcp", "Connect MCP"]] as const).map(([k, l]) => (
              <button key={k} className="cap-segment__btn" data-on={mode === k} onClick={() => { setMode(k); setErr(null); }}>{l}</button>
            ))}
          </div>

          {mode === "yaml" && (
            <div style={{ display: "flex", flexDirection: "column", gap: "var(--s3)" }}>
              <p className="small soft" style={{ margin: 0 }}>A YAML capability wraps an HTTP API — no code runs. Declares its inputs, side-effect, and any secrets it needs.</p>
              <div><label className="label">Name</label><input className="input input-mono" value={yamlName} onChange={e => setYamlName(e.target.value)} placeholder="my.connector" /></div>
              <div><label className="label">YAML</label><textarea className="input input-mono" rows={12} value={yaml} onChange={e => setYaml(e.target.value)} placeholder={"name: my.connector\nsideEffect: read\nhttp:\n  url: https://api.example.com/{{input.id}}\n  method: GET"} style={{ lineHeight: 1.5, fontSize: 12 }} /></div>
            </div>
          )}
          {mode === "file" && (
            <div style={{ display: "flex", flexDirection: "column", gap: "var(--s3)" }}>
              <p className="small soft" style={{ margin: 0 }}>Upload a sandboxed JS/TS plugin. It runs in an isolated subprocess with no access to your secrets unless granted.</p>
              <label className="cap-upload">
                <input type="file" accept=".js,.ts,.mjs" onChange={e => setFile(e.target.files?.[0] ?? null)} style={{ display: "none" }} />
                <Icon d={UI.upload} size={18} />
                <span className="small">{file ? file.name : "Choose a .js / .ts file"}</span>
              </label>
            </div>
          )}
          {mode === "mcp" && (
            <div style={{ display: "flex", flexDirection: "column", gap: "var(--s3)" }}>
              <p className="small soft" style={{ margin: 0 }}>Connect an MCP server by launch command (stdio) or URL (HTTP/SSE). Every tool it exposes becomes a capability.</p>
              <div><label className="label">Name</label><input className="input" value={name} onChange={e => setName(e.target.value)} placeholder="my-server" /></div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--s3)" }}>
                <div><label className="label">Command (stdio)</label><input className="input input-mono" value={command} onChange={e => setCommand(e.target.value)} placeholder="npx" /></div>
                <div><label className="label">Args</label><input className="input input-mono" value={argsText} onChange={e => setArgsText(e.target.value)} placeholder="-y @scope/server" /></div>
              </div>
              <div><label className="label">…or URL (HTTP/SSE)</label><input className="input input-mono" value={url} onChange={e => setUrl(e.target.value)} placeholder="https://my-mcp.example.com/sse" /></div>
            </div>
          )}
          {err && <div className="state-error" style={{ marginTop: "var(--s4)" }}>{err}</div>}
        </div>
        <div className="cap-drawer__foot">
          <button className="btn btn-primary cap-install-cta" disabled={busy} onClick={submit}>{busy ? "Installing…" : "Install"}</button>
        </div>
      </aside>
    </>
  );
}

// ── INSTALLED tab (control panel) ────────────────────────────────────────────
function InstalledTab({ caps, servers, loading, loadErr, q, query, setQuery, autonomy, onChange, onRetry, flash, onView, onAdd }: {
  caps: CapabilityRecord[]; servers: McpServerRecord[]; loading: boolean; loadErr: string | null;
  q: string; query: string; setQuery: (s: string) => void; autonomy: Autonomy;
  onChange: () => Promise<void>; onRetry: () => Promise<void>; flash: (m: string) => void; onView: (c: CapabilityRecord) => void; onAdd: () => void;
}) {
  const filtered = caps.filter(c => !q || `${c.name} ${c.description ?? ""}`.toLowerCase().includes(q));
  const builtins = filtered.filter(c => c.kind === "builtin");
  const plugins = filtered.filter(c => c.kind !== "builtin");

  if (loading) return <div className="state-loading" style={{ marginTop: "var(--s7)" }}><span className="spinner" aria-hidden="true" /><span>Loading capabilities…</span></div>;
  if (loadErr) return (
    <div className="state-error" style={{ marginTop: "var(--s7)", textAlign: "center", padding: "var(--s7)" }}>
      <p style={{ margin: "0 0 var(--s3)" }}>Couldn&apos;t load capabilities — {loadErr}</p>
      <button className="btn btn-secondary btn-sm" onClick={() => void onRetry()}>Retry</button>
    </div>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--s7)" }}>
      <SearchBar query={query} setQuery={setQuery} placeholder="Search installed…" onAdd={onAdd} />

      {plugins.length > 0 && (
        <Section title="Your plugins" sub="Installed by you — enable, disable, or remove">
          <div className="cap-grid">{plugins.map(c => <CapCard key={c.name} cap={c} autonomy={autonomy} onChange={onChange} flash={flash} onView={onView} />)}</div>
        </Section>
      )}

      <div id="connectors" style={{ scrollMarginTop: "var(--s8)" }} />
      <Connectors servers={servers} onChange={onChange} flash={flash} onAdd={onAdd} />

      <BuiltinSection builtins={builtins} autonomy={autonomy} onChange={onChange} flash={flash} onView={onView} />
    </div>
  );
}

function BuiltinSection({ builtins, autonomy, onChange, flash, onView }: {
  builtins: CapabilityRecord[]; autonomy: Autonomy; onChange: () => Promise<void>; flash: (m: string) => void; onView: (c: CapabilityRecord) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const FIRST = 9;
  const shown = showAll ? builtins : builtins.slice(0, FIRST);
  return (
    <Section title="Built-in" sub={`Shipped with Krelvan — always available · ${builtins.length}`}>
      <div className="cap-grid">{shown.map(c => <CapCard key={c.name} cap={c} autonomy={autonomy} onChange={onChange} flash={flash} onView={onView} />)}</div>
      {builtins.length > FIRST && (
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
      <div className="cap-card__top">
        <IconTile name={cap.name} kind={cap.kind} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="cap-card__title mono" style={{ fontSize: 14 }}>{cap.name}</div>
          <div className="cap-card__meta small muted">{cap.kind === "builtin" ? "Built-in" : "Plugin"}</div>
        </div>
        {cap.status === "enabled" && <span className="badge badge-done cap-badge"><span className="dot" />on</span>}
        {cap.status === "disabled" && <span className="badge badge-neutral cap-badge">off</span>}
        {cap.kind === "builtin" && <span className="micro" style={{ color: "var(--ink-muted)" }}>always on</span>}
      </div>
      {cap.description && <p className="small cap-card__desc">{cap.description}</p>}
      {cap.secretRefs && cap.secretRefs.length > 0 && (
        <div className="small" style={{ color: "var(--ink-muted)" }}>
          Needs: {cap.secretRefs.map(s => (
            <a key={s} href={`/secrets?name=${encodeURIComponent(s)}`} className="mono" style={{ color: "var(--brand)" }} title={`Set ${s} in Secrets`}>{s} </a>
          ))}
        </div>
      )}
      <div className="cap-card__tags" style={{ justifyContent: "space-between" }}>
        <SideEffectBadge effect={cap.sideEffect} gated={gated} />
        <button className="btn btn-ghost btn-sm" onClick={() => onView(cap)} style={{ padding: "0 var(--s2)" }}>View source</button>
      </div>
      {isPlugin && (
        <div className="cap-card__foot" style={{ flexWrap: "wrap" }}>
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
function Connectors({ servers, onChange, flash, onAdd }: { servers: McpServerRecord[]; onChange: () => Promise<void>; flash: (m: string) => void; onAdd: () => void }) {
  // Two-step confirm (keyed by server name) — Disconnect tears down the server AND every
  // capability it exposes, so it's irreversible. Mirrors the delete-confirm pattern.
  const [confirmDisconnect, setConfirmDisconnect] = useState<string | null>(null);
  return (
    <Section title="Connectors" sub="MCP servers — each exposes its tools as capabilities">
      <div style={{ display: "flex", gap: "var(--s2)", marginBottom: "var(--s4)", flexWrap: "wrap", alignItems: "center" }}>
        <button className="btn btn-primary btn-sm" onClick={onAdd}><Icon d={UI.plus} size={13} /> Connect a server</button>
        <span className="small muted">Or install GitHub / Slack / Filesystem from the <b style={{ color: "var(--brand)" }}>Discover</b> tab.</span>
      </div>
      {servers.length === 0 ? (
        <div className="state-empty" style={{ padding: "var(--s7) var(--s6)" }}>
          <span className="glyph-chip" style={{ width: 36, height: 36, color: "var(--brand)" }}><Icon d={UI.plug} size={18} /></span>
          <p className="h3" style={{ color: "var(--ink)", margin: "var(--s2) 0 0" }}>No connectors yet</p>
          <p className="small soft" style={{ maxWidth: "40ch", margin: "0 auto" }}>Connect an MCP server above, or install one from Discover. Every tool it exposes shows up as a capability.</p>
        </div>
      ) : (
        <div className="cap-grid">
          {servers.map(s => (
            <div key={s.name} className="card cap-card">
              <div className="cap-card__top">
                <IconTile name={s.name} kind="mcp" />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div className="cap-card__title mono" style={{ fontSize: 14 }}>{s.name}</div>
                  <div className="cap-card__meta small muted"><span className="mono">{s.tools.length}</span> tools</div>
                </div>
                <span className={`badge ${s.connected ? "badge-done" : "badge-failed"} cap-badge`}>{s.connected && <span className="dot" />}{s.connected ? "connected" : "error"}</span>
              </div>
              <div className="cap-toollist">
                {s.tools.slice(0, 6).map(t => <span key={t} className="cap-tool mono">{t}</span>)}
                {s.tools.length > 6 && <span className="small muted">+{s.tools.length - 6}</span>}
              </div>
              <div className="cap-card__foot">
                <button
                  className="btn btn-danger btn-sm"
                  onClick={() => {
                    if (confirmDisconnect !== s.name) {
                      setConfirmDisconnect(s.name);
                      setTimeout(() => setConfirmDisconnect(prev => prev === s.name ? null : prev), 3000);
                      return;
                    }
                    setConfirmDisconnect(null);
                    void disconnectMcpServer(s.name)
                      .then(onChange)
                      .then(() => flash(`${s.name} disconnected`))
                      .catch(e => flash(`Couldn't disconnect ${s.name} — ${(e as Error).message}`));
                  }}
                >
                  {confirmDisconnect === s.name ? "Disconnect — removes its tools" : "Disconnect"}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}

// ── Source drawer: view (read-only) or edit (YAML) an installed capability ────
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
          <button className="btn btn-ghost btn-sm cap-drawer__x" onClick={onClose} aria-label="Close"><Icon d={UI.close} size={14} /></button>
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
              {src.editable && <button className="btn btn-secondary btn-sm" style={{ marginTop: "var(--s3)" }} onClick={() => setEditing(true)}>Edit YAML</button>}
            </>
          )}
        </div>
      </aside>
    </>
  );
}
