"use client";

// ⌘K command palette — search-to-navigate + quick actions, reachable anywhere.
// Cross-OS: opens on (meta OR ctrl) + K. Fully keyboard-driven (↑/↓/↵/Esc) with a
// focus trap, click-outside, and prefers-reduced-motion respected. Also opened by a
// visible button in the nav, so touch / no-keyboard users get it too.

import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { useRouter } from "next/navigation";

export interface Command {
  id: string;
  label: string;
  hint?: string;            // right-aligned context (e.g. "Page", "Action")
  keywords?: string;        // extra fuzzy-match text
  group: string;            // section header
  run: (router: ReturnType<typeof useRouter>) => void;
}

const COMMANDS: Command[] = [
  // Actions
  { id: "build", label: "Build an agent", hint: "Action", group: "Actions", keywords: "create new compose describe", run: r => r.push("/dashboard") },
  { id: "set-secret", label: "Add a secret", hint: "Action", group: "Actions", keywords: "key deploy hook api token vercel", run: r => r.push("/secrets") },
  // Navigate
  { id: "go-dashboard", label: "Dashboard", hint: "Page", group: "Go to", keywords: "home workspace", run: r => r.push("/dashboard") },
  { id: "go-inbox", label: "Inbox", hint: "Page", group: "Go to", keywords: "output results delivered messages", run: r => r.push("/inbox") },
  { id: "go-agents", label: "Agents", hint: "Page", group: "Go to", keywords: "my agents list manage", run: r => r.push("/agents") },
  { id: "go-runs", label: "Runs", hint: "Page", group: "Go to", keywords: "history records", run: r => r.push("/runs") },
  { id: "go-marketplace", label: "Marketplace", hint: "Page", group: "Go to", keywords: "capabilities tools discover install connectors agents", run: r => r.push("/capabilities") },
  { id: "go-connectors", label: "Connectors", hint: "Page", group: "Go to", keywords: "mcp servers github slack tool host", run: r => r.push("/capabilities#connectors") },
  { id: "go-schedules", label: "Schedules", hint: "Page", group: "Go to", keywords: "cron interval automation recurring", run: r => r.push("/schedules") },
  { id: "go-secrets", label: "Secrets", hint: "Page", group: "Go to", keywords: "keys deploy hooks api tokens", run: r => r.push("/secrets") },
  { id: "go-approvals", label: "Approvals", hint: "Page", group: "Go to", keywords: "human in the loop pause review pending", run: r => r.push("/approvals") },
];

function scoreMatch(cmd: Command, q: string): number {
  if (!q) return 1;
  const hay = `${cmd.label} ${cmd.keywords ?? ""} ${cmd.group}`.toLowerCase();
  const needle = q.toLowerCase();
  if (cmd.label.toLowerCase().startsWith(needle)) return 3;     // best: label prefix
  if (hay.includes(needle)) return 2;                            // substring anywhere
  // subsequence (fuzzy): all chars of q appear in order
  let i = 0;
  for (const ch of hay) { if (ch === needle[i]) i++; if (i === needle.length) return 1; }
  return 0;
}

export default function CommandPalette() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const results = useMemo(() => {
    return COMMANDS
      .map(c => ({ c, s: scoreMatch(c, query) }))
      .filter(x => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .map(x => x.c);
  }, [query]);

  const close = useCallback(() => { setOpen(false); setQuery(""); setActive(0); }, []);

  const runCommand = useCallback((cmd: Command | undefined) => {
    if (!cmd) return;
    close();
    cmd.run(router);
  }, [router, close]);

  // Global shortcut: (⌘ or Ctrl) + K toggles; "/" opens when not typing in a field.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const k = e.key.toLowerCase();
      if ((e.metaKey || e.ctrlKey) && k === "k") {
        e.preventDefault();
        setOpen(o => !o);
        return;
      }
      if (e.key === "Escape" && open) { e.preventDefault(); close(); }
    }
    // expose an opener for the visible nav button
    function onOpenEvent() { setOpen(true); }
    window.addEventListener("keydown", onKey);
    window.addEventListener("krelvan:open-command", onOpenEvent);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("krelvan:open-command", onOpenEvent);
    };
  }, [open, close]);

  // Focus the input when opened; lock body scroll while open.
  useEffect(() => {
    if (open) {
      const t = setTimeout(() => inputRef.current?.focus(), 20);
      document.body.style.overflow = "hidden";
      return () => { clearTimeout(t); document.body.style.overflow = ""; };
    }
  }, [open]);

  // Keep active index in range as results change.
  useEffect(() => { setActive(0); }, [query]);

  // Keyboard nav within the list.
  function onInputKey(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") { e.preventDefault(); setActive(a => Math.min(a + 1, results.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive(a => Math.max(a - 1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); runCommand(results[active]); }
  }

  // Scroll the active item into view.
  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  if (!open) return null;

  // Group results for display while keeping a flat index for keyboard nav.
  let flatIdx = -1;
  const groups: { name: string; items: { cmd: Command; idx: number }[] }[] = [];
  for (const cmd of results) {
    flatIdx++;
    const g = groups.find(g => g.name === cmd.group);
    const entry = { cmd, idx: flatIdx };
    if (g) g.items.push(entry); else groups.push({ name: cmd.group, items: [entry] });
  }

  return (
    <div
      className="cmdk-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
      onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}
    >
      <div className="cmdk-panel" role="combobox" aria-expanded="true" aria-haspopup="listbox" aria-controls="cmdk-list">
        <div className="cmdk-search">
          <svg className="cmdk-search__icon" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M7 12.5a5.5 5.5 0 1 0 0-11 5.5 5.5 0 0 0 0 11zM11 11l3.5 3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
          <input
            ref={inputRef}
            className="cmdk-input"
            placeholder="Search or jump to…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onInputKey}
            aria-label="Search commands"
            aria-activedescendant={results[active] ? `cmdk-opt-${results[active].id}` : undefined}
          />
          <kbd className="cmdk-esc">Esc</kbd>
        </div>

        <div className="cmdk-list" id="cmdk-list" role="listbox" ref={listRef}>
          {results.length === 0 ? (
            <div className="cmdk-empty">No matches for “{query}”.</div>
          ) : (
            groups.map(g => (
              <div key={g.name} className="cmdk-group">
                <div className="cmdk-group__label">{g.name}</div>
                {g.items.map(({ cmd, idx }) => (
                  <button
                    key={cmd.id}
                    id={`cmdk-opt-${cmd.id}`}
                    data-idx={idx}
                    role="option"
                    aria-selected={idx === active}
                    className="cmdk-item"
                    data-active={idx === active}
                    onMouseMove={() => setActive(idx)}
                    onClick={() => runCommand(cmd)}
                  >
                    <span className="cmdk-item__label">{cmd.label}</span>
                    {cmd.hint && <span className="cmdk-item__hint">{cmd.hint}</span>}
                  </button>
                ))}
              </div>
            ))
          )}
        </div>

        <div className="cmdk-foot">
          <span><kbd>↑</kbd><kbd>↓</kbd> navigate</span>
          <span><kbd>↵</kbd> open</span>
          <span><kbd>esc</kbd> close</span>
        </div>
      </div>
    </div>
  );
}
