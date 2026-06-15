"use client";

import { usePathname } from "next/navigation";
import { useState, useEffect } from "react";
import { listRuns } from "../lib/api";

// Primary nav — kept tight (4 items) for a clean, focused product. MCP and
// Approvals remain reachable (Capabilities links to MCP; Approvals surfaces in nav
// only when something is actually waiting on the user).
const NAV_LINKS = [
  { label: "Dashboard",    href: "/dashboard" },
  { label: "Runs",         href: "/runs" },
  { label: "Capabilities", href: "/capabilities" },
  { label: "Schedules",    href: "/schedules" },
];
const MORE_LINKS = [
  { label: "MCP servers",  href: "/mcp" },
  { label: "Approvals",    href: "/approvals" },
];

export default function NavClient() {
  const pathname = usePathname();
  const [runningCount, setRunningCount] = useState(0);
  const [scrolled, setScrolled] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    async function poll() {
      try {
        const runs = await listRuns();
        if (alive) setRunningCount(runs.filter(r => r.status === "running").length);
      } catch { /* API not reachable yet */ }
    }
    void poll();
    const t = setInterval(() => void poll(), 5000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  useEffect(() => {
    function onScroll() { setScrolled(window.scrollY > 24); }
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // Close the mobile menu on route change.
  useEffect(() => { setMenuOpen(false); }, [pathname]);

  // Lock body scroll while the mobile menu is open.
  useEffect(() => {
    document.body.style.overflow = menuOpen ? "hidden" : "";
    return () => { document.body.style.overflow = ""; };
  }, [menuOpen]);

  // The landing (/) opens on the dark hero. While unscrolled there, the header is
  // transparent with light-on-dark type; everywhere else (and once scrolled) it is
  // the solid warm-paper bar. The mobile menu, when open, forces the solid bar so
  // the hamburger/X stays legible.
  // The header is ALWAYS the solid light bar with dark, readable links — on every
  // page including the landing. (A transparent dark-over-hero variant caused
  // white-on-near-white invisible links, so it is removed.)
  const darkMode = false;
  void scrolled;

  function isActive(href: string) {
    if (href === "/dashboard") return pathname === "/dashboard";
    return pathname.startsWith(href);
  }

  function focusCompose(e: React.MouseEvent) {
    if (pathname === "/" || pathname === "/dashboard") {
      e.preventDefault();
      const ta = document.querySelector<HTMLTextAreaElement>("textarea");
      if (ta) { ta.focus(); ta.scrollIntoView({ behavior: "smooth", block: "center" }); }
    }
    setMenuOpen(false);
  }

  const wordmarkColor = darkMode ? "var(--dark-brand-bright)" : "var(--brand)";
  // higher-contrast idle links for readability (was --ink-soft / --dark-ink-soft)
  const idleLinkColor = darkMode ? "var(--dark-ink)" : "var(--ink)";
  const activeColor   = darkMode ? "var(--dark-ink)" : "var(--brand)";
  const activeBorder  = darkMode ? "var(--dark-brand-bright)" : "var(--brand)";
  const iconColor     = darkMode ? "var(--dark-ink)" : "var(--ink)";

  return (
    <header
      className={darkMode ? "nav-header nav-header--dark" : "nav-header"}
      style={{
        position: "sticky", top: 0, zIndex: 100,
        background: darkMode ? "transparent" : "rgba(248,247,244,.92)",
        backdropFilter: darkMode ? "none" : "blur(12px)",
        WebkitBackdropFilter: darkMode ? "none" : "blur(12px)",
        borderBottom: darkMode ? "1px solid transparent" : "1px solid var(--line)",
        transition: "background var(--t-standard) var(--ease), border-color var(--t-standard) var(--ease)",
      }}
    >
      <div className="container-wide nav-bar">
        {/* left — wordmark + desktop links */}
        <div style={{ display: "flex", alignItems: "center", gap: "var(--s7)", minWidth: 0 }}>
          <a href="/" style={{
            fontWeight: 800, fontSize: 18, color: wordmarkColor,
            letterSpacing: "-.03em", textDecoration: "none", flexShrink: 0,
            transition: "color var(--t-standard) var(--ease)",
          }}>
            Krelvan
          </a>
          <nav className="nav-links" aria-label="Main navigation">
            {NAV_LINKS.map(link => {
              const active = isActive(link.href);
              return (
                <a
                  key={link.href}
                  href={link.href}
                  aria-current={active ? "page" : undefined}
                  style={{
                    fontSize: 14,
                    fontWeight: active ? 600 : 500,
                    color: active ? activeColor : idleLinkColor,
                    textDecoration: "none",
                    padding: "var(--s2) 0",
                    borderBottom: active ? `2px solid ${activeBorder}` : "2px solid transparent",
                    transition: "color var(--t-fast) var(--ease), border-color var(--t-fast) var(--ease)",
                    whiteSpace: "nowrap",
                  }}
                >
                  {link.label}
                </a>
              );
            })}
          </nav>
        </div>

        {/* right — running badge + CTA (desktop) + hamburger (mobile) */}
        <div style={{ display: "flex", alignItems: "center", gap: "var(--s3)", flexShrink: 0 }}>
          {runningCount > 0 && (
            <span className="badge badge-running nav-running">
              <span className="dot" />
              <span className="mono">{runningCount} running</span>
            </span>
          )}
          <a
            href="/"
            className={`btn btn-sm nav-cta ${darkMode ? "btn-dark-primary" : "btn-primary"}`}
            onClick={focusCompose}
          >
            Build agent
          </a>
          <button
            type="button"
            className="nav-burger"
            aria-label={menuOpen ? "Close menu" : "Open menu"}
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen(o => !o)}
            style={{ color: iconColor }}
          >
            {menuOpen ? (
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
            ) : (
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M3 6h18M3 12h18M3 18h18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
            )}
          </button>
        </div>
      </div>

      {/* mobile slide-down menu */}
      {menuOpen && (
        <>
          <button
            className="nav-scrim"
            aria-label="Close menu"
            onClick={() => setMenuOpen(false)}
          />
          <nav className="nav-mobile" aria-label="Mobile navigation">
            {NAV_LINKS.map(link => {
              const active = isActive(link.href);
              return (
                <a
                  key={link.href}
                  href={link.href}
                  aria-current={active ? "page" : undefined}
                  className="nav-mobile__link"
                  data-active={active}
                  onClick={() => setMenuOpen(false)}
                >
                  {link.label}
                  {active && <span className="nav-mobile__dot" aria-hidden="true" />}
                </a>
              );
            })}
            {MORE_LINKS.map(link => {
              const active = isActive(link.href);
              return (
                <a
                  key={link.href}
                  href={link.href}
                  aria-current={active ? "page" : undefined}
                  className="nav-mobile__link"
                  data-active={active}
                  onClick={() => setMenuOpen(false)}
                >
                  {link.label}
                  {active && <span className="nav-mobile__dot" aria-hidden="true" />}
                </a>
              );
            })}
            <a href="/" className="btn btn-primary nav-mobile__cta" onClick={focusCompose}>
              Build agent →
            </a>
          </nav>
        </>
      )}
    </header>
  );
}
