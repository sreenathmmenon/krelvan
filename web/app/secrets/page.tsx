"use client";

import { useState, useEffect, useCallback } from "react";
import {
  listSecrets,
  setSecret,
  deleteSecret,
  timeAgo,
  type SecretMeta,
  type RequiredSecret,
} from "../../lib/api";

export default function SecretsPage() {
  const [secrets, setSecrets] = useState<SecretMeta[]>([]);
  const [required, setRequired] = useState<RequiredSecret[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [prefillName, setPrefillName] = useState<string>("");

  const load = useCallback(async () => {
    try {
      const data = await listSecrets();
      setSecrets(data.secrets);
      setRequired(data.required);
      setError(null);
    } catch (e) {
      setError((e as Error).message || "Could not reach the Krelvan API.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function handleSave(name: string, value: string) {
    await setSecret(name, value);
    await load();
  }

  async function handleDelete(name: string) {
    await deleteSecret(name);
    await load();
  }

  // Required secrets that aren't set yet — the customer's to-do list (one row per name).
  const missing = dedupeByName(required.filter(r => !r.set));
  const setNames = new Set(secrets.map(s => s.name));
  const stillMissing = missing.filter(m => !setNames.has(m.name));

  return (
    <div className="container" style={{ paddingTop: "var(--s8)", paddingBottom: "var(--s9)" }}>
      {/* header */}
      <div style={{ marginBottom: "var(--s6)" }}>
        <p className="micro" style={{ marginBottom: "var(--s2)" }}>Connections</p>
        <h1 className="h1" style={{ marginBottom: "var(--s2)" }}>Secrets</h1>
        <p className="soft body-lg" style={{ margin: 0, maxWidth: "62ch" }}>
          Your API keys and deploy hooks — stored encrypted on <em>your</em> instance and used
          only to let your agents act in <em>your</em> accounts. A capability that needs a secret
          (like deploying to your Vercel) reads it from here. Values are never shown in full again.
        </p>
      </div>

      {error && (
        <div role="alert" className="state-error" style={{ marginBottom: "var(--s6)", justifyContent: "space-between" }}>
          <span>{error}</span>
          <button
            onClick={() => void load()}
            className="btn btn-sm"
            style={{ background: "transparent", color: "var(--danger)", border: "1px solid var(--danger-ring)", flexShrink: 0 }}
          >
            Retry now
          </button>
        </div>
      )}

      {loading ? (
        <div className="state-loading">
          <span className="spinner" aria-hidden="true" />
          <span>Loading secrets…</span>
        </div>
      ) : (
        <>
          {/* Needed-but-not-set: the actionable to-do list */}
          {stillMissing.length > 0 && (
            <section style={{ marginBottom: "var(--s7)" }}>
              <p className="micro" style={{ marginBottom: "var(--s3)" }}>Needed by your installed capabilities</p>
              <div style={{ display: "flex", flexDirection: "column", gap: "var(--s3)" }}>
                {stillMissing.map(m => (
                  <div
                    key={m.name}
                    className="card"
                    style={{
                      padding: "var(--s4) var(--s5)", display: "flex", alignItems: "center",
                      justifyContent: "space-between", gap: "var(--s4)", flexWrap: "wrap",
                      borderLeft: "3px solid var(--line-strong)",
                    }}
                  >
                    <div style={{ minWidth: 0 }}>
                      <code className="mono" style={{ fontWeight: 600, color: "var(--ink)" }}>{m.name}</code>
                      <div className="small muted" style={{ marginTop: 2 }}>
                        Required by <span className="mono">{m.capability}</span>
                        {m.others.length > 0 && <span> +{m.others.length} more</span>}
                      </div>
                    </div>
                    <button className="btn btn-sm btn-primary" onClick={() => setPrefillName(m.name)}>
                      Set this secret
                    </button>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Add / update form */}
          <SecretForm prefillName={prefillName} onSave={handleSave} onError={setError} onClearPrefill={() => setPrefillName("")} />

          {/* Set secrets */}
          <section style={{ marginTop: "var(--s7)" }}>
            <p className="micro" style={{ marginBottom: "var(--s3)" }}>Your secrets</p>
            {secrets.length === 0 ? (
              <div className="state-empty" style={{ padding: "var(--s8) var(--s6)", gap: "var(--s3)" }}>
                <div
                  aria-hidden="true"
                  style={{
                    width: 52, height: 52, borderRadius: "var(--r-lg)", display: "flex",
                    alignItems: "center", justifyContent: "center", background: "var(--brand-tint)",
                    color: "var(--brand)", fontSize: 24,
                  }}
                >
                  🔑
                </div>
                <div className="h3" style={{ color: "var(--ink)" }}>No secrets yet</div>
                <div className="small soft" style={{ maxWidth: "44ch" }}>
                  When you install a capability that talks to your accounts — a deploy hook,
                  an API key — add the secret here and your agents can use it.
                </div>
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: "var(--s3)" }}>
                {secrets.map(s => (
                  <SecretRow key={s.name} secret={s} onDelete={handleDelete} onUpdate={() => setPrefillName(s.name)} />
                ))}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}

function SecretRow({ secret: s, onDelete, onUpdate }: {
  secret: SecretMeta;
  onDelete: (name: string) => Promise<void>;
  onUpdate: () => void;
}) {
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);

  return (
    <div className="card" style={{ padding: "var(--s4) var(--s5)", display: "flex", alignItems: "center", justifyContent: "space-between", gap: "var(--s4)", flexWrap: "wrap" }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: "var(--s3)", flexWrap: "wrap" }}>
          <code className="mono" style={{ fontWeight: 600, color: "var(--ink)" }}>{s.name}</code>
          <span className="badge badge-done"><span className="dot" />set</span>
        </div>
        <div className="small muted" style={{ marginTop: 2 }}>
          <span className="mono">{s.preview}</span> · updated {timeAgo(s.updatedAt)}
        </div>
      </div>
      <div style={{ display: "flex", gap: "var(--s2)", alignItems: "center" }}>
        {!confirm ? (
          <>
            <button className="btn btn-sm btn-secondary" onClick={onUpdate}>Update</button>
            <button className="btn btn-sm btn-danger" onClick={() => setConfirm(true)}>Remove</button>
          </>
        ) : (
          <>
            <span className="micro" style={{ color: "var(--danger)" }}>Remove?</span>
            <button className="btn btn-sm btn-secondary" onClick={() => setConfirm(false)}>Cancel</button>
            <button
              className="btn btn-sm btn-danger"
              disabled={busy}
              onClick={async () => { setBusy(true); await onDelete(s.name); setBusy(false); }}
            >
              {busy ? "…" : "Yes, remove"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function SecretForm({ prefillName, onSave, onError, onClearPrefill }: {
  prefillName: string;
  onSave: (name: string, value: string) => Promise<void>;
  onError: (e: string) => void;
  onClearPrefill: () => void;
}) {
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);

  // When a "Set this secret" / "Update" button supplies a name, fill it in.
  useEffect(() => {
    if (prefillName) { setName(prefillName); setValue(""); }
  }, [prefillName]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) { onError("Secret name is required."); return; }
    if (!value.trim()) { onError("Secret value is required."); return; }
    setSaving(true);
    try {
      await onSave(name.trim(), value);
      setName(""); setValue(""); onClearPrefill();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={(e) => void handleSubmit(e)} className="card" style={{ padding: "var(--s6)", boxShadow: "var(--shadow-md)" }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: "var(--s4)", marginBottom: "var(--s5)" }}>
        <h2 className="h2">Add or update a secret</h2>
        <span className="small muted">Stored encrypted on this instance.</span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--s5)" }}>
        <label style={{ display: "flex", flexDirection: "column", gap: "var(--s2)" }}>
          <span className="micro">Name</span>
          <input
            className="input input-mono"
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="vercel-deploy-hook"
          />
          <span className="small muted">Must match the <code className="mono">{"{{secret:name}}"}</code> a capability expects.</span>
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: "var(--s2)" }}>
          <span className="micro">Value</span>
          <input
            type="password"
            className="input input-mono"
            value={value}
            onChange={e => setValue(e.target.value)}
            placeholder="paste your hook URL or API key"
            autoComplete="off"
          />
          <span className="small muted">Sent once over your local connection, then encrypted. Never shown again.</span>
        </label>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: "var(--s3)", borderTop: "1px solid var(--line)", paddingTop: "var(--s5)" }}>
          <button type="submit" className="btn btn-primary" disabled={saving}>
            {saving ? "Saving…" : "Save secret"}
          </button>
        </div>
      </div>
    </form>
  );
}

// Collapse multiple capabilities needing the same secret into one row.
function dedupeByName(rows: RequiredSecret[]): { name: string; capability: string; others: string[] }[] {
  const byName = new Map<string, { name: string; capability: string; others: string[] }>();
  for (const r of rows) {
    const existing = byName.get(r.name);
    if (existing) existing.others.push(r.capability);
    else byName.set(r.name, { name: r.name, capability: r.capability, others: [] });
  }
  return [...byName.values()];
}
