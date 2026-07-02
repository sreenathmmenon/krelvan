// Shared site footer — rendered on every page via the root layout (except auth pages).
"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { KrelvanLogo } from "./KrelvanLogo";

export default function SiteFooter() {
  const pathname = usePathname();
  if (pathname === "/login" || pathname === "/setup") return null;
  return (
    <footer style={{ background: "var(--canvas)", borderTop: "1px solid var(--line)" }}>
      <div className="container" style={{ paddingTop: "var(--s8)", paddingBottom: "var(--s7)" }}>
        <div className="footer-cols">
          {/* brand + ownership statement */}
          <div style={{ maxWidth: "32ch" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "var(--s3)", marginBottom: "var(--s3)" }}>
              <KrelvanLogo size={18} />
              <span className="small muted">Own your agents.</span>
            </div>
            <p className="small soft" style={{ lineHeight: 1.6 }}>
              Describe a goal, get a real agent, and keep a signed record of every step.
              Self-hosted, no vendor lock-in.
            </p>
          </div>

          <nav aria-label="Product">
            <p className="micro" style={{ marginBottom: "var(--s3)" }}>Product</p>
            <ul style={{ listStyle: "none", display: "flex", flexDirection: "column", gap: "var(--s2)" }}>
              <li><Link href="/dashboard" className="small" style={{ color: "var(--ink-soft)" }}>Dashboard</Link></li>
              <li><Link href="/capabilities" className="small" style={{ color: "var(--ink-soft)" }}>Capabilities</Link></li>
              <li><Link href="/runs" className="small" style={{ color: "var(--ink-soft)" }}>Runs</Link></li>
              <li><Link href="/schedules" className="small" style={{ color: "var(--ink-soft)" }}>Schedules</Link></li>
              <li><Link href="/faq" className="small" style={{ color: "var(--ink-soft)" }}>FAQ</Link></li>
            </ul>
          </nav>

          <nav aria-label="Workspace">
            <p className="micro" style={{ marginBottom: "var(--s3)" }}>Workspace</p>
            <ul style={{ listStyle: "none", display: "flex", flexDirection: "column", gap: "var(--s2)" }}>
              <li><Link href="/capabilities#connectors" className="small" style={{ color: "var(--ink-soft)" }}>Connectors</Link></li>
              <li><Link href="/secrets" className="small" style={{ color: "var(--ink-soft)" }}>Secrets</Link></li>
              <li><Link href="/approvals" className="small" style={{ color: "var(--ink-soft)" }}>Approvals</Link></li>
              <li><Link href="/capabilities" className="small" style={{ color: "var(--ink-soft)" }}>Marketplace</Link></li>
              <li><a href="https://github.com/sreenathmmenon/krelvan" className="small" style={{ color: "var(--ink-soft)" }}>Download</a></li>
            </ul>
          </nav>

          <nav aria-label="Connect">
            <p className="micro" style={{ marginBottom: "var(--s3)" }}>Connect</p>
            <ul style={{ listStyle: "none", display: "flex", flexDirection: "column", gap: "var(--s2)" }}>
              <li><a href="https://github.com/sreenathmmenon/krelvan" className="small" style={{ color: "var(--ink-soft)" }}>GitHub</a></li>
              <li><a href="https://x.com/sreenathmmenon" className="small" style={{ color: "var(--ink-soft)" }}>Twitter / X</a></li>
              <li><a href="https://github.com/sreenathmmenon/krelvan#readme" className="small" style={{ color: "var(--ink-soft)" }}>Docs</a></li>
              <li><a href="mailto:zreenathmenon@gmail.com" className="small" style={{ color: "var(--ink-soft)" }}>Email</a></li>
            </ul>
          </nav>
        </div>

        <div className="divider" style={{ margin: "var(--s6) 0 var(--s4)" }} />
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "var(--s4)", flexWrap: "wrap" }}>
          <p className="small muted mono">© 2026 Krelvan</p>
          <p className="small muted mono">Open-source · Self-hosted</p>
        </div>
      </div>
    </footer>
  );
}
