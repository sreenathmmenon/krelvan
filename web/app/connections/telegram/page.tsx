"use client";

import { useState, useEffect, useCallback } from "react";
import {
  getTelegramConnection,
  connectTelegram,
  disconnectTelegram,
  type TelegramConnection,
} from "../../../lib/api";

// ── Connect Telegram ────────────────────────────────────────────────────────────
// A per-user "bring your own bot" flow: the customer creates a bot with @BotFather,
// pastes the token, and Krelvan validates it, auto-detects their chat, and stores the
// token encrypted on this instance. No env vars, no restart. The token never leaves
// the local connection in plaintext and is never shown again.

// Small hand-rolled paper-plane mark for the header (house style: stroke SVG, no emoji).
function TelegramMark({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M21 4L3 11l6 2.2L19 6.5 11 15v4l2.8-3L18 18l3-14z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
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

export default function ConnectTelegramPage() {
  const [conn, setConn] = useState<TelegramConnection | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setConn(await getTelegramConnection());
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
            <TelegramMark />
          </span>
          <h1 className="h1" style={{ margin: 0 }}>Connect Telegram</h1>
        </div>
        <p className="soft body-lg" style={{ margin: 0, maxWidth: "60ch" }}>
          Connect your own Telegram bot so agents can message you and your team. Your bot
          token is encrypted and stored only on <em>your</em> Krelvan — it is never shown again.
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

function ConnectedCard({ conn, onDisconnect }: { conn: TelegramConnection; onDisconnect: () => Promise<void> }) {
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function handleDisconnect() {
    setBusy(true);
    setErr(null);
    try {
      await disconnectTelegram();
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
            Connected{conn.botUsername ? <> as <span className="mono">@{conn.botUsername}</span></> : ""}
          </div>
          {conn.chatName && (
            <div className="small muted" style={{ marginTop: 2 }}>
              Delivering to <span style={{ color: "var(--ink)", fontWeight: 500 }}>{conn.chatName}</span>
            </div>
          )}
        </div>
      </div>

      <p className="small soft" style={{ margin: "0 0 var(--s5)", maxWidth: "62ch" }}>
        Agents with a Telegram delivery target now send here. Your token is encrypted on this
        instance — remove it any time and agents stop messaging Telegram.
      </p>

      {err && <div className="state-error" role="alert" style={{ margin: "0 0 var(--s4)" }}>{err}</div>}

      <div style={{ display: "flex", justifyContent: "flex-end", gap: "var(--s3)", borderTop: "1px solid var(--line)", paddingTop: "var(--s5)" }}>
        {!confirm ? (
          <button className="btn btn-danger" onClick={() => setConfirm(true)}>Disconnect</button>
        ) : (
          <>
            <span className="small" style={{ color: "var(--danger)", alignSelf: "center", marginRight: "auto" }}>
              Disconnect this bot?
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
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // When the bot has no messages yet, we hold the detected username so we can tell the
  // user exactly which bot to open, then retry with the same token.
  const [needsMessage, setNeedsMessage] = useState<{ botUsername: string } | null>(null);

  async function attempt() {
    const t = token.trim();
    if (!t) { setErr("Paste your bot token to connect."); return; }
    setBusy(true);
    setErr(null);
    try {
      const res = await connectTelegram(t);
      if (res.ok) {
        setNeedsMessage(null);
        await onConnected();
        return;
      }
      // ok:false → the bot exists but has no messages yet.
      setNeedsMessage({ botUsername: res.botUsername });
    } catch (e) {
      setNeedsMessage(null);
      setErr((e as Error).message || "That bot token isn't valid. Check it from @BotFather.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--s5)" }}>
      {/* Step 1 — create the bot */}
      <div className="card" style={{ padding: "var(--s6)" }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: "var(--s3)", marginBottom: "var(--s3)" }}>
          <span className="micro" style={{ color: "var(--brand)" }}>Step 1</span>
          <h2 className="h3" style={{ color: "var(--ink)", margin: 0 }}>Create a bot</h2>
        </div>
        <ol className="small soft" style={{ margin: 0, paddingLeft: "1.2em", lineHeight: 1.7 }}>
          <li>
            Open{" "}
            <a href="https://t.me/BotFather" target="_blank" rel="noopener noreferrer" style={{ color: "var(--brand)", fontWeight: 500 }}>
              @BotFather
            </a>{" "}
            in Telegram.
          </li>
          <li>Send <span className="mono" style={{ color: "var(--ink)" }}>/newbot</span> and follow the prompts to name it.</li>
          <li>Copy the token it gives you — it looks like <span className="mono">123456789:AA…</span> — and paste it below.</li>
        </ol>
      </div>

      {/* Step 2 — paste the token */}
      <div className="card" style={{ padding: "var(--s6)", boxShadow: "var(--shadow-md)" }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: "var(--s3)", marginBottom: "var(--s4)" }}>
          <span className="micro" style={{ color: "var(--brand)" }}>Step 2</span>
          <h2 className="h3" style={{ color: "var(--ink)", margin: 0 }}>Paste your bot token</h2>
        </div>

        <label style={{ display: "flex", flexDirection: "column", gap: "var(--s2)" }}>
          <span className="label" style={{ marginBottom: 0 }}>Bot token</span>
          <input
            type="password"
            className="input input-mono"
            value={token}
            onChange={(e) => { setToken(e.target.value); setNeedsMessage(null); setErr(null); }}
            placeholder="123456789:AA…"
            autoComplete="off"
            spellCheck={false}
            onKeyDown={(e) => { if (e.key === "Enter" && !busy) void attempt(); }}
          />
          <span className="small muted" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <LockMark />
            Sent once over your local connection, then encrypted. Never shown again.
          </span>
        </label>

        {needsMessage && (
          <div
            role="status"
            style={{
              marginTop: "var(--s4)", padding: "var(--s4)", borderRadius: "var(--r)",
              background: "var(--brand-tint)", border: "1px solid color-mix(in srgb, var(--brand) 28%, transparent)",
              color: "var(--ink)", fontSize: 13, lineHeight: 1.55,
            }}
          >
            Almost there. Open{" "}
            <a href={`https://t.me/${needsMessage.botUsername}`} target="_blank" rel="noopener noreferrer" style={{ color: "var(--brand)", fontWeight: 600 }}>
              @{needsMessage.botUsername}
            </a>{" "}
            in Telegram and tap <strong>Start</strong> (or send any message), then press Retry so we can
            detect your chat.
          </div>
        )}

        {err && <div className="state-error" role="alert" style={{ margin: "var(--s4) 0 0" }}>{err}</div>}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: "var(--s3)", borderTop: "1px solid var(--line)", paddingTop: "var(--s5)", marginTop: "var(--s5)" }}>
          <button className="btn btn-primary" onClick={() => void attempt()} disabled={busy}>
            {busy ? "Connecting…" : needsMessage ? "Retry" : "Connect"}
          </button>
        </div>
      </div>
    </div>
  );
}
