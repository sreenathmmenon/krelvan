"use client";

// Root error boundary — catches errors in the root layout itself (must render its own
// <html>/<body>). Minimal, dependency-free, self-styled so it works even if globals.css failed.
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, fontFamily: "system-ui, -apple-system, sans-serif", background: "#F8F7F4", color: "#11201F" }}>
        <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", textAlign: "center", padding: 24 }}>
          <div style={{ maxWidth: 440 }}>
            <div style={{ fontFamily: "monospace", fontWeight: 700, fontSize: 18, color: "#0C726B", letterSpacing: "-0.02em", marginBottom: 12 }}>Krelvan</div>
            <h1 style={{ fontSize: 24, margin: "0 0 12px" }}>Something went wrong</h1>
            <p style={{ color: "#3A4543", lineHeight: 1.6, margin: "0 0 24px" }}>
              The app hit an unexpected error. Your data is safe.
            </p>
            <button onClick={() => reset()} style={{ background: "#0C726B", color: "#fff", border: "none", borderRadius: 8, padding: "10px 18px", fontSize: 15, cursor: "pointer" }}>
              Reload
            </button>
          </div>
        </div>
      </body>
    </html>
  );
}
