"use client";

import { usePathname } from "next/navigation";
import Link from "next/link";
import { useState, useEffect, useRef, useCallback } from "react";
import { listRuns, logout } from "../lib/api";
import CommandPalette from "./CommandPalette";
import { KrelvanLogo } from "./KrelvanLogo";

// Flat nav: 4 primary links, a divider, then 3 utility links — all visible, one
// click each (no dropdown). A sliding indicator tracks the active item, and ⌘K
// opens a command palette to jump anywhere.
const NAV_LINKS = [
  { label: "Dashboard",    href: "/dashboard" },
  { label: "Runs",         href: "/runs" },
  { label: "Capabilities", href: "/capabilities" },
  { label: "Schedules",    href: "/schedules" },
];
const MORE_LINKS = [
  { label: "Connectors",   href: "/capabilities#connectors" },
  { label: "Secrets",      href: "/secrets" },
  { label: "Approvals",    href: "/approvals" },
];
const ALL_LINKS = [...NAV_LINKS, ...MORE_LINKS];

export default function NavClient() {
  const pathname = usePathname();
  const [runningCount, setRunningCount] = useState(0);
  const [scrolled, setScrolled] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [isMac, setIsMac] = useState(true);
  const navLinksRef = useRef<HTMLElement>(null);
  const [indicator, setIndicator] = useState<{ left: number; width: number; show: boolean }>({ left: 0, width: 0, show: false });

  // Detect platform for the ⌘ vs Ctrl hint (purely cosmetic; the shortcut listens
  // for both meta and ctrl regardless).
  useEffect(() => {
    setIsMac(/mac|iphone|ipad|ipod/i.test(navigator.platform || navigator.userAgent));
  }, []);

  // Position the sliding indicator under the active link. Recomputed on route
  // change and on resize (so it stays correct at every screen width).
  const positionIndicator = useCallback(() => {
    const root = navLinksRef.current;
    if (!root) return;
    const el = root.querySelector<HTMLElement>('[data-active="true"]');
    if (!el) { setIndicator(i => ({ ...i, show: false })); return; }
    const rootBox = root.getBoundingClientRect();
    const box = el.getBoundingClientRect();
    setIndicator({ left: box.left - rootBox.left, width: box.width, show: true });
  }, []);

  useEffect(() => {
    positionIndicator();
    const ro = new ResizeObserver(() => positionIndicator());
    if (navLinksRef.current) ro.observe(navLinksRef.current);
    window.addEventListener("resize", positionIndicator);
    // re-measure after fonts settle
    const t = setTimeout(positionIndicator, 120);
    return () => { ro.disconnect(); window.removeEventListener("resize", positionIndicator); clearTimeout(t); };
  }, [pathname, positionIndicator]);

  function openCommand() { window.dispatchEvent(new Event("krelvan:open-command")); }

  useEffect(() => {
    if (pathname === "/login" || pathname === "/setup") return; // don't poll on auth pages
    let alive = true;
    async function poll() {
      try {
        const runs = await listRuns();
        if (alive) setRunningCount(runs.filter(r => r.status === "running").length);
      } catch { /* API not reachable yet / not logged in */ }
    }
    void poll();
    const t = setInterval(() => void poll(), 5000);
    return () => { alive = false; clearInterval(t); };
  }, [pathname]);

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
  const iconColor     = darkMode ? "var(--dark-ink)" : "var(--ink)";

  // Auth pages (login/setup) are standalone — no nav chrome.
  if (pathname === "/login" || pathname === "/setup") return null;

  // Public marketing pages (home, FAQ) get a MARKETING nav — a logged-out visitor must not
  // see the authenticated app shell (Dashboard/Runs/Secrets/Approvals + sign-out), which
  // reads as a leaked internal build. Just: logo · FAQ · GitHub · one primary CTA.
  const isPublic = pathname === "/" || pathname === "/faq";
  if (isPublic) {
    const onDark = pathname === "/"; // the home hero is dark
    return (
      <header
        className={onDark ? "nav-header nav-header--dark" : "nav-header"}
        style={{
          position: "sticky", top: 0, zIndex: 100,
          background: onDark ? "transparent" : "rgba(248,247,244,.92)",
          backdropFilter: onDark ? "none" : "blur(12px)",
          WebkitBackdropFilter: onDark ? "none" : "blur(12px)",
          borderBottom: onDark ? "1px solid transparent" : "1px solid var(--line)",
        }}
      >
        <div className="container-wide nav-bar">
          <div style={{ display: "flex", alignItems: "center", gap: "var(--s6)", minWidth: 0 }}>
            <Link href="/" aria-label="Krelvan — home" style={{ textDecoration: "none", flexShrink: 0 }}>
              <KrelvanLogo size={20} markColor={onDark ? "var(--dark-brand-bright)" : "var(--brand)"} inkColor={onDark ? "var(--dark-ink)" : "var(--ink)"} />
            </Link>
            <nav className="nav-links" aria-label="Main navigation">
              <Link href="/faq" className="nav-link" data-active={pathname === "/faq"}>FAQ</Link>
              <a href="https://github.com/sreenathmmenon/krelvan" className="nav-link" target="_blank" rel="noopener noreferrer">GitHub</a>
            </nav>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "var(--s3)", flexShrink: 0 }}>
            <Link href="/login" className="nav-link" style={{ opacity: 0.9 }}>Sign in</Link>
            <a href="https://github.com/sreenathmmenon/krelvan" target="_blank" rel="noopener noreferrer"
              className={`btn btn-sm nav-cta ${onDark ? "btn-dark-primary" : "btn-primary"}`}>
              Get started
            </a>
          </div>
        </div>
      </header>
    );
  }

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
          <Link href="/" aria-label="Krelvan — home" style={{
            textDecoration: "none", flexShrink: 0, marginRight: "var(--s3)",
            transition: "color var(--t-standard) var(--ease)",
          }}>
            <KrelvanLogo size={20} markColor={wordmarkColor} inkColor={iconColor} />
          </Link>
          <nav className="nav-links" aria-label="Main navigation" ref={navLinksRef}>
            {NAV_LINKS.map(link => {
              const active = isActive(link.href);
              return (
                <Link
                  key={link.href}
                  href={link.href}
                  className="nav-link"
                  data-active={active}
                  aria-current={active ? "page" : undefined}
                >
                  {link.label}
                </Link>
              );
            })}
            <span className="nav-divider" aria-hidden="true" />
            {MORE_LINKS.map(link => {
              const active = isActive(link.href);
              return (
                <Link
                  key={link.href}
                  href={link.href}
                  className="nav-link nav-link--util"
                  data-active={active}
                  aria-current={active ? "page" : undefined}
                >
                  {link.label}
                </Link>
              );
            })}
            {/* sliding active-indicator — position set in JS, glides via CSS transition */}
            <span
              className="nav-indicator"
              aria-hidden="true"
              style={{ left: indicator.left, width: indicator.width, opacity: indicator.show ? 1 : 0 }}
            />
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
          <button
            type="button"
            className="nav-cmdk"
            onClick={openCommand}
            aria-label="Open command palette"
            title={`Search & jump — ${isMac ? "⌘K" : "Ctrl K"}`}
          >
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M7 12.5a5.5 5.5 0 1 0 0-11 5.5 5.5 0 0 0 0 11zM11 11l3.5 3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
            </svg>
            <kbd>{isMac ? <><span className="kbd-sym">⌘</span>K</> : "Ctrl K"}</kbd>
          </button>
          <a
            href="/dashboard"
            className={`btn btn-sm nav-cta ${darkMode ? "btn-dark-primary" : "btn-primary"}`}
            onClick={focusCompose}
          >
            Build agent
          </a>
          <button
            type="button"
            className="nav-cmdk"
            onClick={() => { void logout(); }}
            aria-label="Sign out"
            title="Sign out"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M6 14H3.5A1.5 1.5 0 0 1 2 12.5v-9A1.5 1.5 0 0 1 3.5 2H6M10.5 11l3-3-3-3M13 8H6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
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
            <button type="button" className="btn btn-secondary nav-mobile__cta" onClick={() => { setMenuOpen(false); openCommand(); }} style={{ marginTop: "var(--s2)" }}>
              Search & jump
            </button>
            <a href="/dashboard" className="btn btn-primary nav-mobile__cta" onClick={focusCompose}>
              Build agent →
            </a>
          </nav>
        </>
      )}

      {/* ⌘K command palette — global, mounted once */}
      <CommandPalette />
    </header>
  );
}
