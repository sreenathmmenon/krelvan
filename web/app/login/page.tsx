"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

export default function LoginPage() {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  // On load, check whether the install still needs first-run setup.
  useEffect(() => {
    fetch("/proxy/api/auth/status")
      .then((r) => r.json())
      .then((d) => { if (d.setupNeeded) router.replace("/setup"); else setReady(true); })
      .catch(() => setReady(true));
  }, [router]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const res = await fetch("/proxy/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        setError(d.error ?? "Login failed");
        setBusy(false);
        return;
      }
      const d = await res.json();
      if (d.csrf) sessionStorage.setItem("krelvan_csrf", d.csrf);
      router.replace("/");
    } catch {
      setError("Could not reach the server.");
      setBusy(false);
    }
  }

  if (!ready) return null;

  return (
    <div className="auth-split">
      {/* left — branded proof panel (dark), matches the home hero identity */}
      <aside className="auth-split__brand">
        <div className="auth-split__brand-inner">
          {/* back to home — the wordmark links to the landing page */}
          <Link href="/" className="auth-split__wordmark display" aria-label="Krelvan — back to home"
            style={{ display: "inline-block", textDecoration: "none", color: "var(--dark-brand-bright)" }}>
            ← Krelvan
          </Link>
          <h1 className="auth-split__tagline display">
            AI agents that <span className="dark-teal">prove what they did</span>.
          </h1>
          <p className="auth-split__sub">
            Every step an agent takes is signed into a tamper-evident ledger. Export any run
            and re-check the math yourself, offline — no server, no trust in us.
          </p>
          <div className="auth-split__trust">
            <span>Open source</span><span aria-hidden="true">·</span>
            <span>Apache-2.0</span><span aria-hidden="true">·</span>
            <span>Self-hosted</span>
          </div>
        </div>
      </aside>

      {/* right — the form */}
      <main className="auth-split__form">
        <div className="auth-split__card">
          <div className="micro" style={{ marginBottom: "var(--s2)" }}>Welcome back</div>
          <div className="h2" style={{ color: "var(--ink)", marginBottom: "var(--s5)" }}>Sign in to your workspace</div>
          <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: "var(--s4)" }}>
            <label className="small" style={{ display: "flex", flexDirection: "column", gap: 6, color: "var(--ink-soft)", fontWeight: 500 }}>
              Username
              <input className="input" value={username} onChange={(e) => setUsername(e.target.value)}
                autoComplete="username" autoFocus required />
            </label>
            <label className="small" style={{ display: "flex", flexDirection: "column", gap: 6, color: "var(--ink-soft)", fontWeight: 500 }}>
              Password
              <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password" required />
            </label>
            {error && <div className="state-error" role="alert" style={{ margin: 0 }}>{error}</div>}
            <button className="btn btn-primary btn-lg" type="submit" disabled={busy} style={{ marginTop: "var(--s2)" }}>
              {busy ? "Signing in…" : "Sign in →"}
            </button>
          </form>
          <p className="small muted" style={{ marginTop: "var(--s5)", lineHeight: 1.6 }}>
            No instance yet? Krelvan is self-hosted — your admin account is created on first run.{" "}
            <a href="https://github.com/sreenathmmenon/krelvan#quick-start" target="_blank" rel="noopener noreferrer" style={{ color: "var(--brand)", fontWeight: 500 }}>
              Read the 60-second setup →
            </a>
          </p>
        </div>
      </main>
    </div>
  );
}
