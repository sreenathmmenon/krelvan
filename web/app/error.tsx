"use client";
import { useEffect } from "react";
import Link from "next/link";

// Segment error boundary — a render exception on any page lands here (branded, recoverable)
// instead of Next.js's default unstyled error screen.
export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    // eslint-disable-next-line no-console
    console.error(error);
  }, [error]);
  return (
    <div className="container" style={{ minHeight: "62vh", display: "flex", alignItems: "center", justifyContent: "center", textAlign: "center" }}>
      <div style={{ maxWidth: "46ch" }}>
        <span className="glyph-chip" style={{ width: 40, height: 40, color: "var(--danger)", margin: "0 auto var(--s4)" }} aria-hidden="true">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none"><path d="M12 3.5l9 16H3l9-16z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round"/><path d="M12 9.5v4.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/><circle cx="12" cy="17" r="1" fill="currentColor"/></svg>
        </span>
        <h1 className="h2" style={{ color: "var(--ink)", marginBottom: "var(--s3)" }}>Something went wrong</h1>
        <p className="body soft" style={{ marginBottom: "var(--s5)", lineHeight: 1.6 }}>
          This page hit an unexpected error. Your data is safe — try again, or head back home.
        </p>
        {error?.message && (
          <p className="mono small" style={{ color: "var(--ink-muted)", marginBottom: "var(--s5)", wordBreak: "break-word" }}>{error.message}</p>
        )}
        <div style={{ display: "flex", gap: "var(--s3)", justifyContent: "center", flexWrap: "wrap" }}>
          <button className="btn btn-primary" onClick={() => reset()}>Try again</button>
          <Link href="/" className="btn btn-secondary">Back home</Link>
        </div>
      </div>
    </div>
  );
}
