"use client";

import { usePathname } from "next/navigation";
import Link from "next/link";
import { useState, useEffect, useRef, useCallback } from "react";
import { listRuns, logout } from "../lib/api";
import { MARKETING_ONLY } from "../lib/deployment";
import CommandPalette from "./CommandPalette";
import { KrelvanLogo } from "./KrelvanLogo";

// ── Product nav ──────────────────────────────────────────────────────────────
// The authenticated header is a real product surface, not an admin panel:
//   [ logo · Dashboard · Agents · Marketplace · Runs ]     [ N running · ⌘K · Build agent · Settings ▾ ]
// The four primary links each carry a small teal glyph. Utility routes
// (Model & secrets / Schedules / Connectors / Approvals + Sign out) live in an
// accessible "Settings" dropdown. Model setup is first because it is required
// for the core customer journey and must be discoverable without knowing a URL.

// 16×16 stroke glyphs, house style (matches lib/glyphs.ts). key → path.
const G = {
  dashboard:  "M2.5 2.5h4v4h-4zM9.5 2.5h4v4h-4zM2.5 9.5h4v4h-4zM9.5 9.5h4v4h-4z",              // grid
  inbox:      "M2.5 8.5h3l1 2h3l1-2h3M2.5 8.5 4 3.2A1 1 0 0 1 5 2.5h6a1 1 0 0 1 1 .7l1.5 5.3M2.5 8.5v3.5a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1V8.5", // inbox tray
  agents:     "M8 1.6a2 2 0 1 1 0 4 2 2 0 0 1 0-4zM3.5 14v-1a2.5 2.5 0 0 1 2.5-2.5h4A2.5 2.5 0 0 1 12.5 13v1M8 5.6v2M4.5 8.5A3.5 3.5 0 0 1 8 7.5a3.5 3.5 0 0 1 3.5 1", // node/agent
  marketplace:"M2.5 6h11l-.8-3H3.3L2.5 6zM3 6v7.5h10V6M2.5 6a1.6 1.6 0 0 0 3 0 1.6 1.6 0 0 0 3 0 1.6 1.6 0 0 0 3 0M6.5 13.5v-3h3v3", // storefront
  runs:       "M5 4h8M5 8h8M5 12h5M2.4 4h.01M2.4 8h.01M2.4 12h.01",                             // list/pulse
  schedules:  "M8 2a6 6 0 1 0 0 12A6 6 0 0 0 8 2zM8 5v3l2 1.5",                                  // clock
  connectors: "M6 2v3M10 2v3M4.5 5h7v3a3.5 3.5 0 0 1-7 0V5zM8 11.5v2.5",                         // plug
  secrets:    "M10 6.5a2.5 2.5 0 1 0-3.4 2.3L4 11.4v1.6h1.6l.6-.6h1.2v-1.2h1.2l.6-.6A2.5 2.5 0 0 0 10 6.5zM10.4 5.6h.01", // key
  approvals:  "M8 1.6l5 1.8v3.4c0 3.2-2.1 5.4-5 6.2-2.9-.8-5-3-5-6.2V3.4L8 1.6zM5.6 7.8l1.7 1.7 3-3.4", // check-shield
} as const;

type GlyphKey = keyof typeof G;

function NavIcon({ glyph, size = 16 }: { glyph: GlyphKey; size?: number }) {
  return (
    <svg
      className="nav-ico"
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
    >
      <path d={G[glyph]} stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

type NavItem = { label: string; href: string; glyph: GlyphKey };

// "Dashboard" is the workspace overview; "Agents" is the dedicated, searchable list of every
// agent you own (its own /agents index) — two distinct destinations, no collision.
const PRIMARY: NavItem[] = [
  { label: "Dashboard",   href: "/dashboard",    glyph: "dashboard" },
  { label: "Inbox",       href: "/inbox",        glyph: "inbox" },
  { label: "Agents",      href: "/agents",       glyph: "agents" },
  { label: "Marketplace", href: "/capabilities", glyph: "marketplace" }, // route stays /capabilities
  { label: "Runs",        href: "/runs",         glyph: "runs" },
];

const MORE: NavItem[] = [
  { label: "Model & secrets",  href: "/secrets#model",        glyph: "secrets" },
  { label: "Schedules",       href: "/schedules",             glyph: "schedules" },
  { label: "Connectors",      href: "/capabilities#connectors", glyph: "connectors" },
  { label: "Connect Telegram", href: "/connections/telegram",  glyph: "connectors" },
  { label: "Connect Email",    href: "/connections/email",     glyph: "connectors" },
  { label: "Approvals",       href: "/approvals",             glyph: "approvals" },
];

export default function NavClient() {
  const pathname = usePathname();
  const [runningCount, setRunningCount] = useState(0);
  const [scrolled, setScrolled] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [isMac, setIsMac] = useState(true);
  const moreRef = useRef<HTMLDivElement>(null);
  const moreBtnRef = useRef<HTMLButtonElement>(null);
  const moreItemsRef = useRef<HTMLAnchorElement[]>([]);

  // Detect platform for the ⌘ vs Ctrl hint (purely cosmetic; the shortcut listens
  // for both meta and ctrl regardless).
  useEffect(() => {
    setIsMac(/mac|iphone|ipad|ipod/i.test(navigator.platform || navigator.userAgent));
  }, []);

  function openCommand() { window.dispatchEvent(new Event("krelvan:open-command")); }

  useEffect(() => {
    if (pathname === "/" || pathname === "/faq" || pathname === "/marketplace" || pathname === "/download" || pathname === "/login" || pathname === "/setup" || pathname?.startsWith("/share/") || pathname?.startsWith("/r/") || pathname?.startsWith("/a/")) return;
    let alive = true;
    async function poll() {
      if (document.visibilityState !== "visible") return;
      try {
        const runs = await listRuns();
        if (alive) setRunningCount(runs.filter(r => r.status === "running").length);
      } catch { /* API not reachable yet / not logged in */ }
    }
    void poll();
    const t = setInterval(() => void poll(), 15000);
    const onVisible = () => { if (document.visibilityState === "visible") void poll(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      alive = false;
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [pathname]);

  useEffect(() => {
    function onScroll() { setScrolled(window.scrollY > 24); }
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // Close menus on route change.
  useEffect(() => { setMenuOpen(false); setMoreOpen(false); }, [pathname]);

  // Lock body scroll while the mobile menu is open.
  useEffect(() => {
    document.body.style.overflow = menuOpen ? "hidden" : "";
    return () => { document.body.style.overflow = ""; };
  }, [menuOpen]);

  // "More" dropdown: close on outside-click and Escape; keyboard-navigable.
  useEffect(() => {
    if (!moreOpen) return;
    function onDown(e: MouseEvent) {
      if (moreRef.current && !moreRef.current.contains(e.target as Node)) setMoreOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") { setMoreOpen(false); moreBtnRef.current?.focus(); }
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [moreOpen]);

  // Focus the first item when the dropdown opens (keyboard entry).
  const openMore = useCallback((focusFirst: boolean) => {
    setMoreOpen(true);
    if (focusFirst) requestAnimationFrame(() => moreItemsRef.current[0]?.focus());
  }, []);

  function onMoreBtnKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      openMore(true);
    }
  }

  function onMoreItemKeyDown(e: React.KeyboardEvent<HTMLAnchorElement>, idx: number) {
    const items = moreItemsRef.current;
    if (e.key === "ArrowDown") { e.preventDefault(); items[(idx + 1) % items.length]?.focus(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); items[(idx - 1 + items.length) % items.length]?.focus(); }
    else if (e.key === "Home") { e.preventDefault(); items[0]?.focus(); }
    else if (e.key === "End") { e.preventDefault(); items[items.length - 1]?.focus(); }
    else if (e.key === "Tab") { setMoreOpen(false); }
  }

  // The header is ALWAYS the solid light bar with dark, readable links — on every
  // page including the landing. (A transparent dark-over-hero variant caused
  // white-on-near-white invisible links, so it is removed.)
  const darkMode = false;
  void scrolled;

  function isActive(href: string) {
    const base = href.split("#")[0]!;
    if (base === "/dashboard") return pathname === "/dashboard";
    return pathname.startsWith(base);
  }
  const moreActive = MORE.some(l => isActive(l.href));

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
  // Public artifact share pages have no app chrome — a logged-out recipient sees only the output.
  if (pathname?.startsWith("/share/") || pathname?.startsWith("/r/") || pathname?.startsWith("/a/")) return null;

  // Public marketing pages (home, FAQ) get a MARKETING nav — a logged-out visitor must not
  // see the authenticated app shell (Dashboard/Runs/Secrets/Approvals + sign-out), which
  // reads as a leaked internal build. Just: logo · FAQ · GitHub · one primary CTA.
  const isPublic = pathname === "/" || pathname === "/faq" || pathname === "/marketplace" || pathname === "/download";
  if (isPublic) {
    // The public header renders as a LIGHT (cream) bar on both / and /faq — so the logo and
    // links must use DARK ink, never dark-mode white (which was invisible on the light bar).
    return (
      <header
        className="nav-header"
        style={{
          position: "sticky", top: 0, zIndex: 100,
          background: "rgba(248,247,244,.92)",
          backdropFilter: "blur(12px)",
          WebkitBackdropFilter: "blur(12px)",
          borderBottom: "1px solid var(--line)",
        }}
      >
        <div className="container-wide nav-bar">
          <div style={{ display: "flex", alignItems: "center", gap: "var(--s6)", minWidth: 0 }}>
            <Link href="/" aria-label="Krelvan — home" style={{ textDecoration: "none", flexShrink: 0 }}>
              <KrelvanLogo size={20} markColor="var(--brand)" inkColor="var(--ink)" />
            </Link>
            <nav className="nav-links" aria-label="Main navigation">
              {/* Real product nav — what a visitor actually wants: build it, browse the
                  marketplace, read the docs. FAQ + GitHub are secondary, not the whole menu. */}
              <a href={pathname === "/" ? "#builder" : "/#builder"} className="nav-link">Build an agent</a>
              <Link href="/marketplace" className="nav-link" data-active={pathname === "/marketplace"}>Marketplace</Link>
              <Link href="/download" className="nav-link" data-active={pathname === "/download"}>Download</Link>
              <a href="https://github.com/sreenathmmenon/krelvan#readme" className="nav-link" target="_blank" rel="noopener noreferrer">Docs</a>
              <Link href="/faq" className="nav-link" data-active={pathname === "/faq"}>FAQ</Link>
              <a href="https://github.com/sreenathmmenon/krelvan" className="nav-link" target="_blank" rel="noopener noreferrer" aria-label="GitHub repository">GitHub</a>
            </nav>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "var(--s3)", flexShrink: 0 }}>
            {!MARKETING_ONLY && <Link href="/login" className="nav-link" style={{ opacity: 0.9 }}>Sign in</Link>}
            <Link href="/download" className="btn btn-sm nav-cta btn-primary">
              Download
            </Link>
          </div>
          {MARKETING_ONLY && (
            <div className="public-mobile-actions">
              <Link href="/marketplace" className="nav-link">Registry</Link>
              <Link href="/download" className="btn btn-primary btn-sm">Download</Link>
            </div>
          )}
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
        {/* left — wordmark + primary product links */}
        <div style={{ display: "flex", alignItems: "center", gap: "var(--s6)", minWidth: 0 }}>
          <Link href="/" aria-label="Krelvan — home" style={{
            textDecoration: "none", flexShrink: 0,
            transition: "color var(--t-standard) var(--ease)",
          }}>
            <KrelvanLogo size={20} markColor={wordmarkColor} inkColor={iconColor} />
          </Link>
          <nav className="nav-links" aria-label="Main navigation">
            {PRIMARY.map(link => {
              const active = isActive(link.href);
              return (
                <Link
                  key={link.label}
                  href={link.href}
                  className="nav-link nav-link--icon"
                  data-active={active}
                  aria-current={active ? "page" : undefined}
                >
                  <NavIcon glyph={link.glyph} />
                  <span>{link.label}</span>
                </Link>
              );
            })}
          </nav>
        </div>

        {/* right — running badge + ⌘K + Build agent + Settings dropdown */}
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

          {/* Settings dropdown — model connection first, then utility routes + sign out */}
          <div className="nav-more" ref={moreRef}>
            <button
              type="button"
              ref={moreBtnRef}
              className="nav-cmdk nav-more__btn"
              data-active={moreActive || undefined}
              aria-haspopup="menu"
              aria-expanded={moreOpen}
              onClick={() => (moreOpen ? setMoreOpen(false) : openMore(false))}
              onKeyDown={onMoreBtnKeyDown}
            >
              <span>Settings</span>
              <svg className="nav-more__chev" width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true"
                style={{ transform: moreOpen ? "rotate(180deg)" : "none" }}>
                <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
            {moreOpen && (
              <div className="nav-more__menu" role="menu" aria-label="Settings">
                {MORE.map((link, idx) => {
                  const active = isActive(link.href);
                  return (
                    <Link
                      key={link.label}
                      href={link.href}
                      role="menuitem"
                      ref={el => { if (el) moreItemsRef.current[idx] = el; }}
                      className="nav-more__item"
                      data-active={active}
                      aria-current={active ? "page" : undefined}
                      tabIndex={-1}
                      onClick={() => setMoreOpen(false)}
                      onKeyDown={e => onMoreItemKeyDown(e, idx)}
                    >
                      <NavIcon glyph={link.glyph} />
                      <span>{link.label}</span>
                    </Link>
                  );
                })}
                <span className="nav-more__sep" aria-hidden="true" />
                <button
                  type="button"
                  role="menuitem"
                  className="nav-more__item nav-more__item--danger"
                  tabIndex={-1}
                  onClick={() => { setMoreOpen(false); void logout(); }}
                  onKeyDown={e => {
                    // keep arrow-nav working from the last item (sign out sits after MORE items)
                    if (e.key === "ArrowUp") { e.preventDefault(); moreItemsRef.current[MORE.length - 1]?.focus(); }
                  }}
                >
                  <svg className="nav-ico" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                    <path d="M6 14H3.5A1.5 1.5 0 0 1 2 12.5v-9A1.5 1.5 0 0 1 3.5 2H6M10.5 11l3-3-3-3M13 8H6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  <span>Sign out</span>
                </button>
              </div>
            )}
          </div>

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
            {[...PRIMARY, ...MORE].map(link => {
              const active = isActive(link.href);
              return (
                <a
                  key={link.label}
                  href={link.href}
                  aria-current={active ? "page" : undefined}
                  className="nav-mobile__link"
                  data-active={active}
                  onClick={() => setMenuOpen(false)}
                >
                  <span className="nav-mobile__label">
                    <NavIcon glyph={link.glyph} />
                    {link.label}
                  </span>
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
            <button type="button" className="nav-mobile__signout" onClick={() => { setMenuOpen(false); void logout(); }}>
              Sign out
            </button>
          </nav>
        </>
      )}

      {/* ⌘K command palette — global, mounted once */}
      <CommandPalette />
    </header>
  );
}
