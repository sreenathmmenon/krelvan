"use client";

import { useState, useEffect, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";

function SetupForm() {
  const router = useRouter();
  const params = useSearchParams();
  const tokenFromUrl = params.get("token") ?? "";

  const [setupToken, setSetupToken] = useState(tokenFromUrl);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  // If setup is already done, there's nothing to do here — go to login.
  useEffect(() => {
    fetch("/proxy/api/auth/status")
      .then((r) => r.json())
      .then((d) => { if (!d.setupNeeded) router.replace("/login"); else setReady(true); })
      .catch(() => setReady(true));
  }, [router]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (password !== confirm) { setError("Passwords do not match."); return; }
    if (password.length < 8) { setError("Password must be at least 8 characters."); return; }
    setBusy(true); setError(null);
    try {
      const res = await fetch("/proxy/api/auth/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password, setupToken }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        setError(d.error ?? "Setup failed");
        setBusy(false);
        return;
      }
      const d = await res.json();
      if (d.csrf) sessionStorage.setItem("krelvan_csrf", d.csrf);
      // Straight into the workspace after first-run setup, not the marketing homepage.
      router.replace("/dashboard");
    } catch {
      setError("Could not reach the server.");
      setBusy(false);
    }
  }

  if (!ready) return null;

  return (
    <div className="auth-split">
      {/* left — branded proof panel (dark), identical identity to the login screen */}
      <aside className="auth-split__brand">
        <div className="auth-split__brand-inner">
          <Link href="/" className="auth-split__wordmark display" aria-label="Krelvan — back to home"
            style={{ display: "inline-block", textDecoration: "none", color: "var(--dark-brand-bright)" }}>
            ← Krelvan
          </Link>
          <h1 className="auth-split__tagline display">
            Write a sentence. <span className="dark-teal">Get a working agent system.</span>
          </h1>
          <p className="auth-split__sub">
            Krelvan turns plain English into real agents that act across your tools and run on
            your schedule — extend them from an open marketplace, publish what you make, and
            sell what works.
          </p>
          <div className="auth-split__trust">
            <span>Open source</span><span aria-hidden="true">·</span>
            <span>Apache-2.0</span><span aria-hidden="true">·</span>
            <span>Self-hosted</span>
          </div>
        </div>
      </aside>

      {/* right — the first-run setup form */}
      <main className="auth-split__form">
        <div className="auth-split__card">
          <div className="micro" style={{ marginBottom: "var(--s2)" }}>First-run setup</div>
          <div className="h2" style={{ color: "var(--ink)", marginBottom: "var(--s2)" }}>Create your admin account</div>
          <p className="small muted" style={{ marginBottom: "var(--s5)", lineHeight: 1.6 }}>
            This is a one-time step — it sets up the owner account for this Krelvan instance.
          </p>
          <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: "var(--s4)" }}>
            {!tokenFromUrl && (
              <label className="small" style={{ display: "flex", flexDirection: "column", gap: 6, color: "var(--ink-soft)", fontWeight: 500 }}>
                Setup token <span style={{ color: "var(--ink-muted)", fontWeight: 400 }}>(printed on the server console)</span>
                <input className="input input-mono" value={setupToken} onChange={(e) => setSetupToken(e.target.value)} required />
                <span className="small" style={{ color: "var(--ink-muted)", fontWeight: 400, lineHeight: 1.5 }}>
                  Copy it from your terminal where Krelvan is running — the line “Create your admin account”.
                  This is not the <code>launcher.token</code> file in your data directory.
                </span>
              </label>
            )}
            <label className="small" style={{ display: "flex", flexDirection: "column", gap: 6, color: "var(--ink-soft)", fontWeight: 500 }}>
              Username
              <input className="input" value={username} onChange={(e) => setUsername(e.target.value)}
                autoComplete="username" autoFocus required minLength={3} />
            </label>
            <label className="small" style={{ display: "flex", flexDirection: "column", gap: 6, color: "var(--ink-soft)", fontWeight: 500 }}>
              Password <span style={{ color: "var(--ink-muted)", fontWeight: 400 }}>(8+ characters)</span>
              <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)}
                autoComplete="new-password" required minLength={8} />
            </label>
            <label className="small" style={{ display: "flex", flexDirection: "column", gap: 6, color: "var(--ink-soft)", fontWeight: 500 }}>
              Confirm password
              <input className="input" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)}
                autoComplete="new-password" required />
            </label>
            {error && <div className="state-error" role="alert" style={{ margin: 0 }}>{error}</div>}
            <button className="btn btn-primary btn-lg" type="submit" disabled={busy || !username || !password || !setupToken} style={{ marginTop: "var(--s2)" }}>
              {busy ? "Creating account…" : "Create admin account →"}
            </button>
          </form>
        </div>
      </main>
    </div>
  );
}

export default function SetupPage() {
  return (
    <Suspense fallback={null}>
      <SetupForm />
    </Suspense>
  );
}
