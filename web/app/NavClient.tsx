"use client";

import { usePathname } from "next/navigation";
import { useState, useEffect } from "react";
import { listRuns } from "../lib/api";

const NAV_LINKS = [
  { label: "Agents",       href: "/" },
  { label: "Runs",         href: "/runs" },
  { label: "Capabilities", href: "/capabilities" },
  { label: "MCP",          href: "/mcp" },
  { label: "Approvals",    href: "/approvals" },
  { label: "Schedules",    href: "/schedules" },
];

export default function NavClient() {
  const pathname = usePathname();
  const [runningCount, setRunningCount] = useState(0);

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

  function isActive(href: string) {
    if (href === "/") return pathname === "/";
    return pathname.startsWith(href);
  }

  function focusCompose(e: React.MouseEvent) {
    if (pathname === "/") {
      e.preventDefault();
      const ta = document.querySelector<HTMLTextAreaElement>("textarea");
      if (ta) { ta.focus(); ta.scrollIntoView({ behavior: "smooth", block: "center" }); }
    }
  }

  return (
    <header style={{
      position: "sticky", top: 0, zIndex: 100,
      background: "rgba(248,247,244,.92)",
      backdropFilter: "blur(12px)",
      borderBottom: "1px solid var(--line)",
    }}>
      <div className="container-wide" style={{
        height: 56,
        display: "flex", alignItems: "center", justifyContent: "space-between",
      }}>
        {/* wordmark */}
        <div style={{ display: "flex", alignItems: "center", gap: "var(--s7)" }}>
          <a href="/" style={{
            fontWeight: 800, fontSize: 18, color: "var(--brand)",
            letterSpacing: "-.03em", textDecoration: "none",
          }}>
            Krelvan
          </a>
          <nav style={{ display: "flex", gap: "var(--s5)" }} aria-label="Main navigation">
            {NAV_LINKS.map(link => {
              const active = isActive(link.href);
              return (
                <a
                  key={link.href}
                  href={link.href}
                  aria-current={active ? "page" : undefined}
                  style={{
                    fontSize: 13,
                    fontWeight: active ? 600 : 500,
                    color: active ? "var(--brand)" : "var(--ink-soft)",
                    textDecoration: "none",
                    padding: "var(--s2) 0",
                    borderBottom: active ? "2px solid var(--brand)" : "2px solid transparent",
                    transition: "color 120ms, border-color 120ms",
                  }}
                >
                  {link.label}
                </a>
              );
            })}
          </nav>
        </div>

        {/* right */}
        <div style={{ display: "flex", alignItems: "center", gap: "var(--s3)" }}>
          {runningCount > 0 && (
            <div style={{
              display: "flex", alignItems: "center", gap: 6, padding: "4px 10px",
              background: "var(--live-tint)", borderRadius: "var(--r-pill)",
            }}>
              <span className="status-dot running" style={{ width: 6, height: 6 }} />
              <span className="mono" style={{ fontSize: 11, color: "var(--live)", fontWeight: 600 }}>
                {runningCount} running
              </span>
            </div>
          )}
          <a href="/" className="btn btn-primary btn-sm" onClick={focusCompose}>
            Build agent
          </a>
        </div>
      </div>
    </header>
  );
}
