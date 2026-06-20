import Link from "next/link";

// Branded 404 — a mistyped URL must never escape the design system.
export default function NotFound() {
  return (
    <div className="container" style={{ minHeight: "62vh", display: "flex", alignItems: "center", justifyContent: "center", textAlign: "center" }}>
      <div style={{ maxWidth: "44ch" }}>
        <p className="mono" style={{ fontSize: 44, fontWeight: 700, color: "var(--brand)", letterSpacing: "-0.02em", marginBottom: "var(--s3)" }}>404</p>
        <h1 className="h2" style={{ color: "var(--ink)", marginBottom: "var(--s3)" }}>This page doesn&apos;t exist</h1>
        <p className="body soft" style={{ marginBottom: "var(--s6)", lineHeight: 1.6 }}>
          The link may be broken or the page may have moved. Everything else is one click away.
        </p>
        <div style={{ display: "flex", gap: "var(--s3)", justifyContent: "center", flexWrap: "wrap" }}>
          <Link href="/" className="btn btn-primary">Back home</Link>
          <Link href="/capabilities" className="btn btn-secondary">Browse the marketplace</Link>
        </div>
      </div>
    </div>
  );
}
