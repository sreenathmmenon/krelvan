// Shared site footer — rendered on every page via the root layout (except auth pages).
"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { KrelvanLogo } from "./KrelvanLogo";

export default function SiteFooter() {
  const pathname = usePathname();
  if (pathname === "/login" || pathname === "/setup") return null;
  // The canvas is a full-viewport interactive tool (its own 100vh workspace + in-app status
  // chip). The marketing footer must not render beneath it and create a dead scroll region.
  if (pathname?.startsWith("/canvas/")) return null;
  // On public pages, a logged-out visitor must not be handed app-gated links (Dashboard,
  // Secrets, Approvals…) that bounce to the login wall — show public-safe destinations instead.
  const isPublic = pathname === "/" || pathname === "/faq";
  const link = (href: string, label: string, ext = false) =>
    ext
      ? <li key={href}><a href={href} className="small" style={{ color: "var(--ink-soft)" }} target="_blank" rel="noopener noreferrer">{label}</a></li>
      : <li key={href}><Link href={href} className="small" style={{ color: "var(--ink-soft)" }}>{label}</Link></li>;
  const productLinks = isPublic
    ? [link("/faq", "FAQ"), link("https://github.com/sreenathmmenon/krelvan#readme", "Docs", true), link("https://github.com/sreenathmmenon/krelvan/blob/main/LICENSE", "License", true), link("https://github.com/sreenathmmenon/krelvan", "Download", true)]
    : [link("/dashboard", "Dashboard"), link("/capabilities", "Marketplace"), link("/runs", "Runs"), link("/schedules", "Schedules"), link("/faq", "FAQ")];
  const workspaceLinks = isPublic
    ? [link("https://github.com/sreenathmmenon/krelvan#readme", "How it works", true), link("https://github.com/sreenathmmenon/krelvan", "Self-host guide", true), link("/login", "Sign in")]
    : [link("/capabilities#connectors", "Connectors"), link("/secrets", "Secrets"), link("/approvals", "Approvals"), link("/capabilities", "Marketplace"), link("https://github.com/sreenathmmenon/krelvan", "Download", true)];
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
              {productLinks}
            </ul>
          </nav>

          <nav aria-label={isPublic ? "Learn" : "Workspace"}>
            <p className="micro" style={{ marginBottom: "var(--s3)" }}>{isPublic ? "Learn" : "Workspace"}</p>
            <ul style={{ listStyle: "none", display: "flex", flexDirection: "column", gap: "var(--s2)" }}>
              {workspaceLinks}
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
