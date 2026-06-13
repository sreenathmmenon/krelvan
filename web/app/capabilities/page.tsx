"use client";
import { useState, useEffect } from "react";
import {
  listCapabilities, installCapability, installCapabilityFile,
  enableCapability, disableCapability, uninstallCapability,
  type CapabilityRecord,
} from "../../lib/api";

const SIDE_EFFECT_COLOR: Record<string, string> = {
  read:                "var(--brand)",
  "read-write":        "var(--live)",
  "write-reversible":  "var(--live)",
  "write-irreversible":"var(--danger)",
  "message-human":     "var(--ok)",
  spend:               "var(--danger)",
  "identity-mutation": "var(--danger)",
};

const STATUS_STYLE: Record<string, { bg: string; color: string }> = {
  enabled:   { bg: "var(--ok-tint)",       color: "var(--ok)" },
  disabled:  { bg: "var(--surface-sunken)", color: "var(--ink-muted)" },
  installed: { bg: "var(--brand-tint)",    color: "var(--brand)" },
};

function CapabilityCard({ cap, onRefresh }: { cap: CapabilityRecord; onRefresh: () => Promise<void> }) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sideEffectColor = SIDE_EFFECT_COLOR[cap.sideEffect] ?? "var(--brand)";
  const statusStyle = cap.status ? (STATUS_STYLE[cap.status] ?? null) : null;
  const isUserPlugin = cap.kind !== "builtin";

  async function act(fn: () => Promise<unknown>) {
    setBusy(true); setError(null);
    try { await fn(); await onRefresh(); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  return (
    <div className="card" style={{ padding: "var(--s5)", display: "flex", flexDirection: "column", gap: "var(--s3)" }}>
      {/* header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "var(--s3)" }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 600, fontSize: 13, color: "var(--ink)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginBottom: "var(--s2)" }}>
            {cap.name}
          </div>
          <div style={{ display: "flex", gap: "var(--s2)", flexWrap: "wrap" }}>
            <span style={{ fontSize: 10, padding: "2px 7px", background: `${sideEffectColor}18`, color: sideEffectColor, borderRadius: "var(--r-pill)", fontWeight: 500 }}>
              {cap.sideEffect}
            </span>
            {/* kind tag — only worth showing if not builtin so user knows what type they installed */}
            {cap.kind !== "builtin" && (
              <span style={{ fontSize: 10, padding: "2px 7px", background: "var(--surface-sunken)", color: "var(--ink-muted)", borderRadius: "var(--r-pill)" }}>
                {cap.kind}
              </span>
            )}
            {cap.version && (
              <span style={{ fontSize: 10, padding: "2px 7px", background: "var(--surface-sunken)", color: "var(--ink-muted)", borderRadius: "var(--r-pill)" }}>
                v{cap.version}
              </span>
            )}
          </div>
        </div>
        {statusStyle && (
          <span style={{ fontSize: 10, padding: "2px 8px", background: statusStyle.bg, color: statusStyle.color, borderRadius: "var(--r-pill)", fontWeight: 600, flexShrink: 0 }}>
            {cap.status}
          </span>
        )}
      </div>

      {cap.description && (
        <p style={{ fontSize: 12, color: "var(--ink-soft)", lineHeight: 1.5, margin: 0 }}>{cap.description}</p>
      )}

      {cap.secretRefs && cap.secretRefs.length > 0 && (
        <div style={{ background: "rgba(217,119,6,.08)", borderRadius: "var(--r)", padding: "var(--s2) var(--s3)", fontSize: 11 }}>
          <span style={{ color: "var(--live)", fontWeight: 600 }}>Requires: </span>
          <span style={{ fontFamily: "var(--font-mono)", color: "var(--ink-soft)" }}>{cap.secretRefs.join(", ")}</span>
        </div>
      )}

      {/* footer */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: "auto", gap: "var(--s2)", flexWrap: "wrap" }}>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--ink-muted)" }}>
          {cap.estimateCents === 0 ? "free" : `~${cap.estimateCents}¢ / call`}
        </span>

        {isUserPlugin && (
          <div style={{ display: "flex", gap: "var(--s2)", alignItems: "center" }}>
            {(cap.status === "installed" || cap.status === "disabled") && (
              <button disabled={busy} onClick={() => act(() => enableCapability(cap.name))} style={{
                fontSize: 11, padding: "3px 10px", borderRadius: "var(--r)",
                border: "1px solid var(--ok)", background: "var(--ok-tint)",
                color: "var(--ok)", cursor: busy ? "not-allowed" : "pointer", opacity: busy ? .6 : 1, fontWeight: 500,
              }}>{busy ? "…" : "Enable"}</button>
            )}
            {cap.status === "enabled" && (
              <button disabled={busy} onClick={() => act(() => disableCapability(cap.name))} style={{
                fontSize: 11, padding: "3px 10px", borderRadius: "var(--r)",
                border: "1px solid var(--line)", background: "var(--surface-sunken)",
                color: "var(--ink-soft)", cursor: busy ? "not-allowed" : "pointer", opacity: busy ? .6 : 1, fontWeight: 500,
              }}>{busy ? "…" : "Disable"}</button>
            )}
            {!confirmDelete ? (
              <button onClick={() => setConfirmDelete(true)} style={{
                fontSize: 11, padding: "3px 10px", borderRadius: "var(--r)",
                border: "1px solid rgba(185,28,28,.25)", background: "none",
                color: "var(--danger)", cursor: "pointer",
              }}>Uninstall</button>
            ) : (
              <div style={{ display: "flex", alignItems: "center", gap: "var(--s2)" }}>
                <span style={{ fontSize: 11, color: "var(--danger)", fontWeight: 500 }}>Remove?</span>
                <button onClick={() => setConfirmDelete(false)} className="btn btn-sm" style={{ fontSize: 11, height: 26, padding: "0 8px" }}>Cancel</button>
                <button disabled={busy} onClick={() => act(async () => { await uninstallCapability(cap.name); setConfirmDelete(false); })} style={{
                  fontSize: 11, padding: "3px 10px", borderRadius: "var(--r)", border: "none",
                  background: "var(--danger)", color: "white", cursor: busy ? "not-allowed" : "pointer", opacity: busy ? .6 : 1,
                }}>{busy ? "Removing…" : "Yes, remove"}</button>
              </div>
            )}
          </div>
        )}
      </div>

      {error && (
        <div style={{ fontSize: 11, color: "var(--danger)", padding: "var(--s2) var(--s3)", background: "var(--danger-tint)", borderRadius: "var(--r)" }}>
          {error}
        </div>
      )}
    </div>
  );
}

export default function CapabilitiesPage() {
  const [caps, setCaps]         = useState<CapabilityRecord[]>([]);
  const [loading, setLoading]   = useState(true);
  const [showInstall, setShowInstall] = useState(false);
  const [file, setFile]         = useState<File | null>(null);
  const [installing, setInstalling]     = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);
  const [toast, setToast]               = useState<string | null>(null);

  async function reload() {
    try { setCaps(await listCapabilities()); }
    catch { /* ignore */ }
    finally { setLoading(false); }
  }

  useEffect(() => { void reload(); }, []);

  async function handleInstall(e: React.FormEvent) {
    e.preventDefault();
    if (!file) return;
    setInstalling(true); setInstallError(null);
    try {
      const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
      let installed: CapabilityRecord;
      if (ext === "yaml" || ext === "yml") {
        const text = await file.text();
        const nameMatch = text.match(/^name:\s*(.+)$/m);
        const name = nameMatch?.[1]?.trim() ?? file.name.replace(/\.[^.]+$/, "");
        installed = await installCapability(name, text);
      } else {
        installed = await installCapabilityFile(file);
      }
      setFile(null); setShowInstall(false);
      await reload();
      setToast(`"${installed.name}" installed and enabled`);
      setTimeout(() => setToast(null), 4000);
    } catch (err) { setInstallError((err as Error).message); }
    finally { setInstalling(false); }
  }

  const builtins  = caps.filter(c => c.kind === "builtin");
  const enabled   = caps.filter(c => c.kind !== "builtin" && c.status === "enabled");
  const installed = caps.filter(c => c.kind !== "builtin" && c.status === "installed");
  const disabled  = caps.filter(c => c.kind !== "builtin" && c.status === "disabled");

  return (
    <div className="container" style={{ paddingTop: "var(--s7)", paddingBottom: "var(--s9)" }}>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "var(--s6)" }}>
        <div>
          <h1 className="h1" style={{ marginBottom: "var(--s2)" }}>Capabilities</h1>
          <p style={{ fontSize: 14, color: "var(--ink-soft)", margin: 0 }}>
            Plugins your agents can use.
          </p>
        </div>
        <button className="btn btn-primary" onClick={() => { setShowInstall(!showInstall); setInstallError(null); setFile(null); }}>
          {showInstall ? "Cancel" : "+ Install"}
        </button>
      </div>

      {showInstall && (
        <div className="card" style={{ padding: "var(--s5)", marginBottom: "var(--s6)", maxWidth: 480 }}>
          <form onSubmit={(e) => void handleInstall(e)}>
            <div style={{ display: "flex", flexDirection: "column", gap: "var(--s4)" }}>
              <div>
                <label className="micro" style={{ display: "block", marginBottom: "var(--s2)" }}>Plugin file</label>
                <input
                  type="file"
                  accept=".yaml,.yml,.js,.ts,.mjs"
                  onChange={e => { setFile(e.target.files?.[0] ?? null); setInstallError(null); }}
                  style={{ fontSize: 13, color: "var(--ink)" }}
                />
                <p style={{ fontSize: 11, color: "var(--ink-muted)", marginTop: "var(--s2)" }}>
                  .yaml / .yml for HTTP API plugins · .js / .ts for code plugins
                </p>
              </div>
              {installError && (
                <div style={{ padding: "var(--s3) var(--s4)", background: "var(--danger-tint)", borderRadius: "var(--r)", fontSize: 13, color: "var(--danger)" }}>
                  {installError}
                </div>
              )}
              <div style={{ display: "flex", gap: "var(--s3)" }}>
                <button type="button" className="btn btn-ghost" onClick={() => setShowInstall(false)}>Cancel</button>
                <button type="submit" className="btn btn-primary" disabled={!file || installing}>
                  {installing ? "Installing…" : "Install"}
                </button>
              </div>
            </div>
          </form>
        </div>
      )}

      {toast && (
        <div style={{
          position: "fixed", bottom: "var(--s6)", right: "var(--s6)", zIndex: 100,
          padding: "var(--s3) var(--s5)", background: "var(--ok)", color: "#fff",
          borderRadius: "var(--r)", fontSize: 13, fontWeight: 500,
          boxShadow: "0 4px 16px rgba(0,0,0,.18)",
        }}>
          {toast}
        </div>
      )}

      {loading && <p style={{ fontSize: 13, color: "var(--ink-muted)" }}>Loading…</p>}

      {!loading && (
        <>
          {enabled.length > 0 && (
            <CapSection label="Enabled" count={enabled.length} color="var(--ok)">
              {enabled.map(cap => <CapabilityCard key={cap.name} cap={cap} onRefresh={reload} />)}
            </CapSection>
          )}
          {installed.length > 0 && (
            <CapSection label="Installed" count={installed.length} color="var(--brand)">
              {installed.map(cap => <CapabilityCard key={cap.name} cap={cap} onRefresh={reload} />)}
            </CapSection>
          )}
          {disabled.length > 0 && (
            <CapSection label="Disabled" count={disabled.length} color="var(--ink-muted)">
              {disabled.map(cap => <CapabilityCard key={cap.name} cap={cap} onRefresh={reload} />)}
            </CapSection>
          )}
          {builtins.length > 0 && (
            <CapSection label="Built-in" count={builtins.length} color="var(--ink-muted)">
              {builtins.map(cap => <CapabilityCard key={cap.name} cap={cap} onRefresh={reload} />)}
            </CapSection>
          )}
        </>
      )}
    </div>
  );
}

function CapSection({ label, count, color, children }: { label: string; count: number; color: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: "var(--s7)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "var(--s3)", marginBottom: "var(--s4)" }}>
        <span className="micro">{label}</span>
        <span style={{ fontSize: 11, padding: "1px 7px", background: `${color}18`, color, borderRadius: "var(--r-pill)", fontWeight: 600 }}>
          {count}
        </span>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: "var(--s4)" }}>
        {children}
      </div>
    </div>
  );
}
