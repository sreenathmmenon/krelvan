"use client";

import { useState, useEffect, useCallback } from "react";
import {
  getEmailConnection,
  connectEmail,
  disconnectEmail,
  type EmailConnection,
} from "../../../lib/api";

// ── Connect Email ───────────────────────────────────────────────────────────────
// A per-user "bring your own key" flow: the customer creates a Resend API key, pastes
// it, and Krelvan validates it against Resend and stores it encrypted on this instance.
// No env vars, no restart. The key never leaves the local connection in plaintext and
// is never shown again. Sender defaults to Resend's shared onboarding address so email
// works instantly with no domain setup.

// Small hand-rolled envelope mark for the header (house style: stroke SVG, no emoji).
function EmailMark({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="3" y="5" width="18" height="14" rx="2" stroke="currentColor" strokeWidth="1.5" />
      <path d="M3.5 6.5l8.5 6 8.5-6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function CheckMark({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M3.5 8.5l3 3 6-7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function LockMark({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="3.5" y="7" width="9" height="6" rx="1.2" stroke="currentColor" strokeWidth="1.3" />
      <path d="M5.5 7V5.2a2.5 2.5 0 0 1 5 0V7" stroke="currentColor" strokeWidth="1.3" fill="none" />
    </svg>
  );
}

export default function ConnectEmailPage() {
  const [conn, setConn] = useState<EmailConnection | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setConn(await getEmailConnection());
      setError(null);
    } catch (e) {
      setError((e as Error).message || "Could not reach the Krelvan API.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  return (
    <div className="container" style={{ paddingTop: "var(--s8)", paddingBottom: "var(--s9)", maxWidth: 720 }}>
      <div style={{ marginBottom: "var(--s6)" }}>
        <p className="micro" style={{ marginBottom: "var(--s2)" }}>Connections</p>
        <div style={{ display: "flex", alignItems: "center", gap: "var(--s3)", marginBottom: "var(--s2)" }}>
          <span
            aria-hidden="true"
            style={{
              width: 40, height: 40, borderRadius: "var(--r-lg)", display: "flex",
              alignItems: "center", justifyContent: "center",
              background: "var(--brand-tint)", color: "var(--brand)", flexShrink: 0,
            }}
          >
            <EmailMark />
          </span>
          <h1 className="h1" style={{ margin: 0 }}>Connect Email</h1>
        </div>
        <p className="soft body-lg" style={{ margin: 0, maxWidth: "60ch" }}>
          Connect email delivery so your agents can send their output to you and your
          customers by email.
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
          <span>Checking connection…</span>
        </div>
      ) : conn?.connected ? (
        <ConnectedCard conn={conn} onDisconnect={load} />
      ) : (
        <ConnectFlow onConnected={load} />
      )}
    </div>
  );
}

function ConnectedCard({ conn, onDisconnect }: { conn: EmailConnection; onDisconnect: () => Promise<void> }) {
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function handleDisconnect() {
    setBusy(true);
    setErr(null);
    try {
      await disconnectEmail();
      await onDisconnect();
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="card" style={{ padding: "var(--s6)", boxShadow: "var(--shadow-md)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "var(--s3)", marginBottom: "var(--s4)" }}>
        <span
          aria-hidden="true"
          style={{
            width: 34, height: 34, borderRadius: "50%", display: "flex",
            alignItems: "center", justifyContent: "center",
            background: "var(--ok-tint)", color: "var(--ok)", flexShrink: 0,
          }}
        >
          <CheckMark size={17} />
        </span>
        <div style={{ minWidth: 0 }}>
          <div className="h3" style={{ color: "var(--ink)" }}>
            Connected{conn.from ? <> — sending from <span className="mono">{conn.from}</span></> : ""}
          </div>
        </div>
      </div>

      <p className="small soft" style={{ margin: "0 0 var(--s5)", maxWidth: "62ch" }}>
        Agents with an email delivery target now send from here. Your API key is encrypted on
        this instance — remove it any time and agents stop sending email.
      </p>

      {err && <div className="state-error" role="alert" style={{ margin: "0 0 var(--s4)" }}>{err}</div>}

      <div style={{ display: "flex", justifyContent: "flex-end", gap: "var(--s3)", borderTop: "1px solid var(--line)", paddingTop: "var(--s5)" }}>
        {!confirm ? (
          <button className="btn btn-danger" onClick={() => setConfirm(true)}>Disconnect</button>
        ) : (
          <>
            <span className="small" style={{ color: "var(--danger)", alignSelf: "center", marginRight: "auto" }}>
              Disconnect email?
            </span>
            <button className="btn btn-secondary" onClick={() => setConfirm(false)} disabled={busy}>Cancel</button>
            <button className="btn btn-danger" onClick={() => void handleDisconnect()} disabled={busy}>
              {busy ? "Disconnecting…" : "Yes, disconnect"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function ConnectFlow({ onConnected }: { onConnected: () => Promise<void> }) {
  const [apiKey, setApiKey] = useState("");
  const [from, setFrom] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function attempt() {
    const key = apiKey.trim();
    if (!key) { setErr("Paste your Resend API key to connect."); return; }
    setBusy(true);
    setErr(null);
    try {
      await connectEmail(key, from.trim() || undefined);
      await onConnected();
    } catch (e) {
      setErr((e as Error).message || "That Resend API key was rejected. Check it at resend.com.");
      setBusy(false);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--s5)" }}>
      {/* Step 1 — get the key */}
      <div className="card" style={{ padding: "var(--s6)" }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: "var(--s3)", marginBottom: "var(--s3)" }}>
          <span className="micro" style={{ color: "var(--brand)" }}>Step 1</span>
          <h2 className="h3" style={{ color: "var(--ink)", margin: 0 }}>Get a Resend API key</h2>
        </div>
        <ol className="small soft" style={{ margin: 0, paddingLeft: "1.2em", lineHeight: 1.7 }}>
          <li>
            Go to{" "}
            <a href="https://resend.com" target="_blank" rel="noopener noreferrer" style={{ color: "var(--brand)", fontWeight: 500 }}>
              resend.com
            </a>{" "}
            and sign up — it&rsquo;s free (100 emails/day).
          </li>
          <li>Create an API key from your dashboard.</li>
          <li>Copy the key — it starts with <span className="mono" style={{ color: "var(--ink)" }}>re_</span> — and paste it below.</li>
        </ol>
      </div>

      {/* Step 2 — paste the key */}
      <div className="card" style={{ padding: "var(--s6)", boxShadow: "var(--shadow-md)" }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: "var(--s3)", marginBottom: "var(--s4)" }}>
          <span className="micro" style={{ color: "var(--brand)" }}>Step 2</span>
          <h2 className="h3" style={{ color: "var(--ink)", margin: 0 }}>Paste your API key</h2>
        </div>

        <label style={{ display: "flex", flexDirection: "column", gap: "var(--s2)" }}>
          <span className="label" style={{ marginBottom: 0 }}>Resend API key</span>
          <input
            type="password"
            className="input input-mono"
            value={apiKey}
            onChange={(e) => { setApiKey(e.target.value); setErr(null); }}
            placeholder="re_…"
            autoComplete="off"
            spellCheck={false}
            onKeyDown={(e) => { if (e.key === "Enter" && !busy) void attempt(); }}
          />
          <span className="small muted" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <LockMark />
            Your API key is encrypted and stored only on your Krelvan — it is never shown again.
          </span>
        </label>

        <label style={{ display: "flex", flexDirection: "column", gap: "var(--s2)", marginTop: "var(--s5)" }}>
          <span className="label" style={{ marginBottom: 0 }}>Send from <span className="muted" style={{ fontWeight: 400 }}>(optional)</span></span>
          <input
            type="text"
            className="input input-mono"
            value={from}
            onChange={(e) => { setFrom(e.target.value); setErr(null); }}
            placeholder="Krelvan <onboarding@resend.dev>"
            autoComplete="off"
            spellCheck={false}
            onKeyDown={(e) => { if (e.key === "Enter" && !busy) void attempt(); }}
          />
          <span className="small muted">
            Leave blank to use Resend&rsquo;s shared sender — works instantly, no domain setup. Add
            your own verified domain later.
          </span>
        </label>

        {err && <div className="state-error" role="alert" style={{ margin: "var(--s4) 0 0" }}>{err}</div>}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: "var(--s3)", borderTop: "1px solid var(--line)", paddingTop: "var(--s5)", marginTop: "var(--s5)" }}>
          <button className="btn btn-primary" onClick={() => void attempt()} disabled={busy}>
            {busy ? (
              <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                <span className="spinner" aria-hidden="true" />
                Connecting…
              </span>
            ) : "Connect"}
          </button>
        </div>
      </div>
    </div>
  );
}
