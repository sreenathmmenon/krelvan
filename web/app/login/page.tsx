"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";

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
    <div style={{ maxWidth: 380, margin: "12vh auto 0", padding: "0 var(--s4)" }}>
      <div className="card" style={{ display: "flex", flexDirection: "column", gap: "var(--s4)" }}>
        <div>
          <div className="h2" style={{ color: "var(--ink)" }}>Sign in to Krelvan</div>
          <p className="small" style={{ color: "var(--ink-soft)", margin: "var(--s2) 0 0" }}>
            Own, run, and trust your own AI agents.
          </p>
        </div>
        <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: "var(--s3)" }}>
          <label className="small" style={{ display: "flex", flexDirection: "column", gap: 4, color: "var(--ink-soft)" }}>
            Username
            <input className="input" value={username} onChange={(e) => setUsername(e.target.value)}
              autoComplete="username" autoFocus required />
          </label>
          <label className="small" style={{ display: "flex", flexDirection: "column", gap: 4, color: "var(--ink-soft)" }}>
            Password
            <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password" required />
          </label>
          {error && <div className="small" style={{ color: "var(--danger)" }}>{error}</div>}
          <button className="btn btn-primary" type="submit" disabled={busy || !username || !password}>
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </form>
      </div>
    </div>
  );
}
