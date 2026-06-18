"use client";

import { useState, useEffect, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";

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
      router.replace("/");
    } catch {
      setError("Could not reach the server.");
      setBusy(false);
    }
  }

  if (!ready) return null;

  return (
    <div style={{ maxWidth: 420, margin: "10vh auto 0", padding: "0 var(--s4)" }}>
      <div className="card" style={{ display: "flex", flexDirection: "column", gap: "var(--s4)" }}>
        <div>
          <div className="h2" style={{ color: "var(--ink)" }}>Welcome to Krelvan</div>
          <p className="small" style={{ color: "var(--ink-soft)", margin: "var(--s2) 0 0", lineHeight: 1.55 }}>
            Create your admin account. This is a one-time setup.
          </p>
        </div>
        <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: "var(--s3)" }}>
          {!tokenFromUrl && (
            <label className="small" style={{ display: "flex", flexDirection: "column", gap: 4, color: "var(--ink-soft)" }}>
              Setup token <span style={{ color: "var(--ink-muted)" }}>(printed on the server console)</span>
              <input className="input input-mono" value={setupToken} onChange={(e) => setSetupToken(e.target.value)} required />
            </label>
          )}
          <label className="small" style={{ display: "flex", flexDirection: "column", gap: 4, color: "var(--ink-soft)" }}>
            Username
            <input className="input" value={username} onChange={(e) => setUsername(e.target.value)}
              autoComplete="username" autoFocus required minLength={3} />
          </label>
          <label className="small" style={{ display: "flex", flexDirection: "column", gap: 4, color: "var(--ink-soft)" }}>
            Password <span style={{ color: "var(--ink-muted)" }}>(8+ characters)</span>
            <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password" required minLength={8} />
          </label>
          <label className="small" style={{ display: "flex", flexDirection: "column", gap: 4, color: "var(--ink-soft)" }}>
            Confirm password
            <input className="input" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)}
              autoComplete="new-password" required />
          </label>
          {error && <div className="small" style={{ color: "var(--danger)" }}>{error}</div>}
          <button className="btn btn-primary" type="submit" disabled={busy || !username || !password || !setupToken}>
            {busy ? "Creating account…" : "Create admin account"}
          </button>
        </form>
      </div>
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
