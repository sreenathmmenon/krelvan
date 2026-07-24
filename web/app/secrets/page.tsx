"use client";

import { useState, useEffect, useCallback } from "react";
import {
  listSecrets,
  setSecret,
  deleteSecret,
  getModel,
  setModel,
  timeAgo,
  type SecretMeta,
  type RequiredSecret,
  type ModelStatus,
} from "../../lib/api";

// Per-secret "how to get this" guidance so a builder never has to guess where a hook/key
// lives. `steps` is the exact click-path; `href` deep-links to the provider's own docs.
// Most deploy connectors use a Deploy Hook URL — the URL itself IS the secret (no token).
const SECRET_HELP: Record<string, { steps: string; href: string }> = {
  "vercel-deploy-hook": {
    steps: "Vercel → your project → Settings → Git → Deploy Hooks → Create Hook → copy the URL and paste it here.",
    href: "https://vercel.com/docs/deployments/deploy-hooks",
  },
  "netlify-build-hook": {
    steps: "Netlify → your site → Site configuration → Build & deploy → Build hooks → Add build hook → copy the URL.",
    href: "https://docs.netlify.com/configure-builds/build-hooks/",
  },
  "cloudflare-pages-hook": {
    steps: "Cloudflare → Workers & Pages → your Pages project → Settings → Builds → Deploy hooks → Create → copy the URL.",
    href: "https://developers.cloudflare.com/pages/configuration/deploy-hooks/",
  },
  "render-deploy-hook": {
    steps: "Render → your service → Settings → Deploy Hook → copy the URL.",
    href: "https://render.com/docs/deploy-hooks",
  },
  "railway-token": {
    steps: "Railway → Account Settings → Tokens → Create Token → copy it here (or use a project token).",
    href: "https://docs.railway.com/guides/public-api#authentication",
  },
  // ── Web search providers — add ONE of these to give every agent real, live web search.
  // web_search uses whichever you configure; you're not locked to a single vendor.
  "LINKUP_API_KEY": {
    steps: "Linkup → create a free account → API keys → create a key → paste it here. Search built for AI agents (ranked results + sourced answers).",
    href: "https://app.linkup.so/",
  },
  "BRAVE_SEARCH_API_KEY": {
    steps: "Brave Search API → sign up (free tier) → API Keys → create a key → paste it here. This gives all your agents real web search.",
    href: "https://brave.com/search/api/",
  },
  "TAVILY_API_KEY": {
    steps: "Tavily → sign up (free tier, search built for AI) → copy your API key → paste it here.",
    href: "https://tavily.com/",
  },
  "SERPER_API_KEY": {
    steps: "Serper.dev → sign up (free credits, Google results) → API Key → copy it here.",
    href: "https://serper.dev/",
  },
  "SERPAPI_API_KEY": {
    steps: "SerpApi → sign up → Your Account → API Key → copy it here.",
    href: "https://serpapi.com/",
  },
  "YOU_API_KEY": {
    steps: "You.com API → request access → copy your API key → paste it here.",
    href: "https://api.you.com/",
  },
  "BING_SEARCH_API_KEY": {
    steps: "Azure Portal → create a 'Bing Search' resource → Keys and Endpoint → copy Key 1.",
    href: "https://www.microsoft.com/en-us/bing/apis/bing-web-search-api",
  },
};

/** A small "How to get this →" helper rendered under a required-secret card. */
function SecretHelp({ name }: { name: string }) {
  const h = SECRET_HELP[name];
  if (!h) return null;
  return (
    <div className="small muted" style={{ marginTop: "var(--s2)", lineHeight: 1.5 }}>
      {h.steps}{" "}
      <a href={h.href} target="_blank" rel="noopener noreferrer" style={{ color: "var(--brand)", fontWeight: 500, whiteSpace: "nowrap" }}>
        How to get this →
      </a>
    </div>
  );
}

export default function SecretsPage() {
  const [secrets, setSecrets] = useState<SecretMeta[]>([]);
  const [required, setRequired] = useState<RequiredSecret[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [prefillName, setPrefillName] = useState<string>("");
  // When the name was chosen from a required-secret / "Set this secret" card (not typed
  // free-hand), lock the name field so it's set for the exact key a capability expects.
  const [lockName, setLockName] = useState(false);

  // Scroll to + prefill the Add-secret form with a specific secret name, locking the field.
  const setSecretFor = useCallback((name: string) => {
    setPrefillName(name);
    setLockName(true);
    setTimeout(() => document.getElementById("secret-form")?.scrollIntoView({ behavior: "smooth", block: "center" }), 60);
  }, []);

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

  // Deep-link: /secrets?name=vercel-deploy-hook prefills the form (from a capability
  // card's "Set secret" link), and scrolls the form into view.
  useEffect(() => {
    const name = new URLSearchParams(window.location.search).get("name");
    if (name) {
      setPrefillName(name);
      setLockName(true);
      setTimeout(() => document.getElementById("secret-form")?.scrollIntoView({ behavior: "smooth", block: "center" }), 200);
    }
  }, []);

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
        <p className="micro" style={{ marginBottom: "var(--s2)" }}>Secrets</p>
        <h1 className="h1" style={{ marginBottom: "var(--s2)" }}>Secrets &amp; model</h1>
        <p className="soft body-lg" style={{ margin: 0, maxWidth: "62ch" }}>
          The API keys &amp; deploy hooks your agents use, and the language model that powers them —
          all stored encrypted on <em>your</em> instance so agents act only in <em>your</em> accounts.
          Values are never shown in full again.
        </p>
      </div>

      {/* Model — the LLM that builds and powers agents. Lives here so a self-hoster can
          wire up a provider from the UI instead of editing env vars. */}
      <p className="micro" style={{ marginBottom: "var(--s3)" }}>Language model</p>
      <ModelSection />

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
              <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: "var(--s3)", marginBottom: "var(--s2)", flexWrap: "wrap" }}>
                <p className="micro" style={{ margin: 0 }}>Needed by your installed capabilities</p>
                <span className="small muted">{dedupeByName(required).length - stillMissing.length} of {dedupeByName(required).length} configured</span>
              </div>
              <p className="small muted" style={{ margin: "0 0 var(--s4)", maxWidth: "70ch" }}>
                Only these are needed now — each is required by a capability you&apos;ve already installed.
                A key you haven&apos;t installed anything for won&apos;t appear here, so &ldquo;not set&rdquo; is
                expected until you set it or first run that capability.
              </p>
              {/* auto-FIT (not auto-fill) collapses empty column tracks, so a lone last card
                  stretches to fill its row instead of floating beside an empty slot — no orphan.
                  Capped at 2 columns so wide screens stay balanced and readable, and it still
                  collapses to one column below the 340px card minimum on narrow screens. */}
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))", gap: "var(--s3)", maxWidth: stillMissing.length === 1 ? 520 : undefined }}>
                {stillMissing.map(m => (
                  <div
                    key={m.name}
                    className="card"
                    style={{
                      padding: "var(--s4) var(--s5)", display: "flex", alignItems: "center",
                      justifyContent: "space-between", gap: "var(--s4)",
                      borderLeft: "3px solid var(--line-strong)",
                    }}
                  >
                    <div style={{ minWidth: 0 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: "var(--s2)", flexWrap: "wrap" }}>
                        <code className="mono" style={{ fontWeight: 600, color: "var(--ink)" }}>{m.name}</code>
                        <span className="secret-status secret-status--unset">Not set</span>
                      </div>
                      <div className="small muted" style={{ marginTop: 2 }}>
                        Required by <span className="mono">{m.capability}</span>
                        {m.others.length > 0 && <span> +{m.others.length} more</span>}
                      </div>
                      <SecretHelp name={m.name} />
                    </div>
                    <button className="btn btn-sm btn-secondary" onClick={() => setSecretFor(m.name)}>
                      Set this secret
                    </button>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Add / update form */}
          <SecretForm prefillName={prefillName} lockName={lockName} onSave={handleSave} onError={setError} onClearPrefill={() => { setPrefillName(""); setLockName(false); }} />

          {/* Set secrets */}
          <section style={{ marginTop: "var(--s7)" }}>
            <p className="micro" style={{ marginBottom: "var(--s3)" }}>Secrets you&apos;ve saved</p>
            {secrets.length === 0 ? (
              <div className="state-empty" style={{ padding: "var(--s8) var(--s6)", gap: "var(--s3)" }}>
                <div
                  aria-hidden="true"
                  style={{
                    width: 52, height: 52, borderRadius: "var(--r-lg)", display: "flex",
                    alignItems: "center", justifyContent: "center", background: "var(--brand-tint)",
                    color: "var(--brand)",
                  }}
                >
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <circle cx="8" cy="8" r="4.5" stroke="currentColor" strokeWidth="1.6" />
                    <path d="M11.2 11.2L20 20M16 16l2-2M18.5 18.5l2-2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                  </svg>
                </div>
                <div className="h3" style={{ color: "var(--ink)" }}>No secrets saved yet</div>
                <div className="small soft" style={{ maxWidth: "46ch" }}>
                  The hooks your installed capabilities need are listed above — set one to save
                  it here, encrypted on your instance. Saved secrets never leave your machine in full.
                </div>
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: "var(--s3)" }}>
                {secrets.map(s => (
                  <SecretRow key={s.name} secret={s} onDelete={handleDelete} onUpdate={() => setSecretFor(s.name)} />
                ))}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}

function ModelSection() {
  const [status, setStatus] = useState<ModelStatus | null>(null);
  const [provider, setProvider] = useState("anthropic");
  const [apiKey, setApiKey] = useState("");
  const [model, setModelName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const refresh = useCallback(async () => {
    try {
      const s = await getModel();
      setStatus(s);
      setProvider(s.provider || "anthropic");
      setModelName(s.model || "");
    } catch { /* API unreachable — leave defaults; the page-level error banner covers it */ }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  // Scroll into view when arriving via /secrets#model (the "Connect a model" CTAs).
  useEffect(() => {
    if (window.location.hash === "#model") {
      setTimeout(() => document.getElementById("model")?.scrollIntoView({ behavior: "smooth", block: "start" }), 150);
    }
  }, []);

  const needsKey = provider !== "ollama";
  const ready = !!status?.hasLlm;

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    if (needsKey && !apiKey.trim() && !ready) { setMsg({ kind: "err", text: `An API key is required for ${provider}.` }); return; }
    setSaving(true);
    try {
      // Only send apiKey if the user typed one — empty means "keep the existing key".
      const cfg: { provider: string; model: string; baseUrl?: string; apiKey?: string } = {
        provider, model: model.trim(),
      };
      if (apiKey.trim()) cfg.apiKey = apiKey.trim();
      if (provider === "ollama") cfg.baseUrl = baseUrl.trim();
      const s = await setModel(cfg);
      setStatus(s);
      setApiKey("");
      setMsg(s.hasLlm
        ? { kind: "ok", text: `Connected — ${s.provider}${s.model ? ` · ${s.model}` : ""}. Your next build will use it.` }
        : { kind: "err", text: `Saved, but ${s.provider} still needs an API key before agents can build.` });
    } catch (e) {
      setMsg({ kind: "err", text: (e as Error).message });
    } finally {
      setSaving(false);
    }
  }

  return (
    <section id="model" style={{ marginBottom: "var(--s7)", scrollMarginTop: "var(--s8)" }}>
      <div className="card" style={{ padding: "var(--s6)", boxShadow: "var(--shadow-md)" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "var(--s4)", marginBottom: "var(--s2)", flexWrap: "wrap" }}>
          <h2 className="h2">Model</h2>
          <span className={`badge ${ready ? "badge-done" : "badge-paused"}`}>
            <span className="dot" />
            {ready ? `Connected · ${status?.provider}${status?.model ? ` · ${status.model}` : ""}` : "No model connected"}
          </span>
        </div>
        <p className="small soft" style={{ margin: "0 0 var(--s5)", maxWidth: "62ch" }}>
          The LLM that turns your plain-English goal into a working agent and reasons inside each run.
          Stored encrypted on <em>this</em> instance. Pick a hosted provider with a key, or point at a
          local Ollama — nothing leaves your machine with Ollama.
        </p>

        <form onSubmit={(e) => void handleSave(e)} style={{ display: "flex", flexDirection: "column", gap: "var(--s5)" }}>
          <label style={{ display: "flex", flexDirection: "column", gap: "var(--s2)" }}>
            <span className="label" style={{ marginBottom: 0 }}>Provider</span>
            <select className="input" value={provider} onChange={e => setProvider(e.target.value)} style={{ maxWidth: 280 }}>
              <option value="anthropic">Anthropic (Claude)</option>
              <option value="openai">OpenAI</option>
              <option value="gemini">Google Gemini</option>
              <option value="groq">Groq</option>
              <option value="mistral">Mistral</option>
              <option value="ollama">Ollama (local, no key)</option>
              <option value="compatible">OpenAI-compatible endpoint</option>
            </select>
          </label>

          {needsKey && (
            <label style={{ display: "flex", flexDirection: "column", gap: "var(--s2)" }}>
              <span className="label" style={{ marginBottom: 0 }}>API key {ready && status?.source === "in-app" ? "(leave blank to keep current)" : ""}</span>
              <input
                type="password" className="input input-mono" value={apiKey}
                onChange={e => setApiKey(e.target.value)} autoComplete="off"
                placeholder={provider === "anthropic" ? "sk-ant-…" : provider === "gemini" ? "AIza… or AQ.…" : provider === "groq" ? "gsk_…" : "sk-…"}
              />
              <span className="small muted">Sent once over your local connection, then encrypted. Never shown again.</span>
            </label>
          )}

          {(provider === "ollama" || provider === "compatible") && (
            <label style={{ display: "flex", flexDirection: "column", gap: "var(--s2)" }}>
              <span className="label" style={{ marginBottom: 0 }}>Base URL {provider === "compatible" ? "(required)" : "(optional)"}</span>
              <input className="input input-mono" value={baseUrl} onChange={e => setBaseUrl(e.target.value)} placeholder={provider === "compatible" ? "https://your-gateway.example/v1" : "http://localhost:11434"} />
            </label>
          )}

          <label style={{ display: "flex", flexDirection: "column", gap: "var(--s2)" }}>
            <span className="label" style={{ marginBottom: 0 }}>Model (optional)</span>
            <input
              className="input input-mono" value={model} onChange={e => setModelName(e.target.value)}
              placeholder={
                provider === "anthropic" ? "claude-sonnet-4-6"
                : provider === "gemini" ? "gemini-2.0-flash"
                : provider === "groq" ? "llama-3.3-70b-versatile"
                : provider === "mistral" ? "mistral-large-latest"
                : provider === "ollama" ? "llama3.2"
                : "gpt-5.6-sol"
              }
            />
            <span className="small muted">Leave blank to use the provider&apos;s default.</span>
          </label>

          {msg && (
            msg.kind === "ok" ? (
              <div style={{ margin: 0, padding: "var(--s3) var(--s4)", borderRadius: "var(--r)", display: "flex", alignItems: "center", gap: "var(--s3)", background: "color-mix(in srgb, var(--ok) 10%, var(--surface))", border: "1px solid color-mix(in srgb, var(--ok) 30%, transparent)", color: "var(--ok)", fontSize: 13, fontWeight: 500 }}>
                {msg.text}
              </div>
            ) : (
              <div className="state-error" role="alert" style={{ margin: 0 }}>{msg.text}</div>
            )
          )}

          <div style={{ display: "flex", justifyContent: "flex-end", gap: "var(--s3)", borderTop: "1px solid var(--line)", paddingTop: "var(--s5)" }}>
            <button type="submit" className="btn btn-primary" disabled={saving}>
              {saving ? "Saving…" : ready ? "Update model" : "Connect model"}
            </button>
          </div>
        </form>
      </div>
    </section>
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

function SecretForm({ prefillName, lockName, onSave, onError, onClearPrefill }: {
  prefillName: string;
  lockName: boolean;
  onSave: (name: string, value: string) => Promise<void>;
  onError: (e: string) => void;
  onClearPrefill: () => void;
}) {
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);

  // When a "Set this secret" / "Update" button supplies a name, fill it in.
  useEffect(() => {
    if (prefillName) { setName(prefillName); setValue(""); setSaved(null); }
  }, [prefillName]);

  // The name is locked (read-only) only when it came from a required-secret / saved-secret
  // card, so a key a capability expects can't be mistyped. Free-hand adds stay editable.
  const locked = lockName && !!name.trim();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) { onError("Secret name is required."); return; }
    if (!value.trim()) { onError("Secret value is required."); return; }
    setSaving(true);
    try {
      const savedName = name.trim();
      await onSave(savedName, value);
      setSaved(savedName);
      setName(""); setValue(""); onClearPrefill();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <form id="secret-form" onSubmit={(e) => void handleSubmit(e)} className="card" style={{ padding: "var(--s6)", boxShadow: "var(--shadow-md)" }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: "var(--s4)", marginBottom: "var(--s5)" }}>
        <h2 className="h2">Add or update a secret</h2>
        <span className="small muted">Stored encrypted on this instance.</span>
      </div>
      {/* Visual confirm once a secret is set from a card — reassures you the exact key landed. */}
      {saved && (
        <div role="status" style={{ margin: "0 0 var(--s5)", padding: "var(--s3) var(--s4)", borderRadius: "var(--r)", display: "flex", alignItems: "center", gap: "var(--s2)", background: "var(--ok-tint)", border: "1px solid color-mix(in srgb, var(--ok) 30%, transparent)", color: "var(--ok)", fontSize: 13, fontWeight: 500 }}>
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
          <span><code className="mono">{saved}</code> is set — stored encrypted on this instance.</span>
        </div>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--s5)" }}>
        <label style={{ display: "flex", flexDirection: "column", gap: "var(--s2)" }}>
          <span className="label" style={{ marginBottom: 0, display: "flex", alignItems: "center", gap: "var(--s2)" }}>
            Name
            {locked && (
              <span className="micro" style={{ display: "inline-flex", alignItems: "center", gap: 4, color: "var(--brand)", textTransform: "none", letterSpacing: 0 }} title="Locked to the exact key this capability expects">
                <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="3.5" y="7" width="9" height="6" rx="1.2" stroke="currentColor" strokeWidth="1.3" /><path d="M5.5 7V5.2a2.5 2.5 0 0 1 5 0V7" stroke="currentColor" strokeWidth="1.3" fill="none" /></svg>
                locked to this key
              </span>
            )}
          </span>
          <input
            className="input input-mono"
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="vercel-deploy-hook"
            readOnly={locked}
            style={locked ? { background: "var(--surface-sunken)", cursor: "not-allowed" } : undefined}
          />
          <span className="small muted">
            {locked
              ? <>Setting the exact key this capability expects. <button type="button" className="btn-link" onClick={onClearPrefill} style={{ background: "none", border: "none", padding: 0, color: "var(--brand)", cursor: "pointer", font: "inherit" }}>Change key</button></>
              : <>Must match the <code className="mono">{"{{secret:name}}"}</code> a capability expects.</>}
          </span>
          {/* When filling a known deploy hook / token, show exactly where to get it. */}
          <SecretHelp name={name.trim()} />
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: "var(--s2)" }}>
          <span className="label" style={{ marginBottom: 0 }}>Value</span>
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
          <button type="submit" className="btn btn-primary" disabled={saving || !name.trim() || !value.trim()}>
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
