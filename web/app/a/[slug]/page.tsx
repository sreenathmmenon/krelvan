"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useParams } from "next/navigation";
import {
  getPublicAgent, getPublicFeed, publicAsk, publicAskPoll,
  type PublicAgentProfile, type PublicFeedItem,
} from "../../../lib/api";
import { renderMarkdown } from "../../../lib/markdown";

// ── Public agent page — /a/[slug] ────────────────────────────────────────────────
// The "your agent is live" storefront: a product page, not a console. Name + one-liner,
// the agent's published output feed (when the owner enabled it), and a chat panel that
// talks to the public /ask endpoint (when chat is enabled). No admin chrome — NavClient
// and SiteFooter suppress themselves on /a/, and the route is excluded from the session
// middleware. The chat thread lives in memory only (never localStorage).

interface ChatTurn { role: "you" | "agent" | "system"; text: string }

function fmtDate(ms: number): string {
  try { return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }); }
  catch { return ""; }
}

export default function PublicAgentPage() {
  const params = useParams<{ slug: string }>();
  const slug = params.slug;
  const [profile, setProfile] = useState<PublicAgentProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [feed, setFeed] = useState<PublicFeedItem[]>([]);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  useEffect(() => {
    let live = true;
    getPublicAgent(slug)
      .then((p) => {
        if (!live) return;
        setProfile(p); setLoading(false);
        if (p.feedEnabled) getPublicFeed(slug).then(items => { if (live) setFeed(items); }).catch(() => {});
      })
      .catch(() => { if (live) { setNotFound(true); setLoading(false); } });
    return () => { live = false; };
  }, [slug]);

  if (loading) {
    return (
      <main style={{ minHeight: "100vh", display: "grid", placeItems: "center", background: "var(--canvas)" }}>
        <div className="state-loading"><span className="spinner" aria-hidden="true" /> Loading…</div>
      </main>
    );
  }
  if (notFound || !profile) {
    return (
      <main style={{ minHeight: "100vh", display: "grid", placeItems: "center", background: "var(--canvas)", padding: "var(--s5)" }}>
        <div style={{ textAlign: "center", maxWidth: "40ch" }}>
          <p className="h3">This agent isn&apos;t available</p>
          <p className="small soft">It may be private, or the link may be wrong. Ask whoever shared it for an up-to-date link.</p>
        </div>
      </main>
    );
  }

  return (
    <main style={{ minHeight: "100vh", background: "var(--canvas)", padding: "var(--s8) var(--s4) var(--s9)" }}>
      <div style={{ maxWidth: 760, margin: "0 auto" }}>
        {/* hero */}
        <header style={{ marginBottom: "var(--s7)" }}>
          <p className="micro" style={{ marginBottom: "var(--s2)" }}>Live agent</p>
          <h1 className="h1" style={{ margin: "0 0 var(--s3)" }}>{profile.name}</h1>
          {profile.intent && <p className="body-lg soft" style={{ margin: 0, maxWidth: "56ch", lineHeight: 1.6 }}>{profile.intent}</p>}
        </header>

        {/* chat */}
        {profile.chatEnabled && profile.siteKey && (
          <ChatPanel slug={slug} siteKey={profile.siteKey} />
        )}

        {/* feed */}
        {profile.feedEnabled && (
          <section style={{ marginTop: profile.chatEnabled ? "var(--s8)" : 0 }}>
            <h2 className="h3" style={{ margin: "0 0 var(--s4)" }}>Recent output</h2>
            {feed.length === 0 ? (
              <p className="small soft">Nothing published yet — check back soon.</p>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: "var(--s3)" }}>
                {feed.map((item, i) => {
                  const open = expanded.has(i);
                  return (
                    <article key={i} className="card" style={{ padding: "var(--s5)" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: "var(--s2)", marginBottom: "var(--s2)" }}>
                        <span className="small muted">{fmtDate(item.createdAt)}</span>
                      </div>
                      <h3 className="h4" style={{ margin: "0 0 var(--s2)", color: "var(--ink)" }}>{item.title}</h3>
                      <div style={{ maxHeight: open ? "none" : 120, overflow: "hidden", position: "relative" }}>
                        {renderMarkdown(item.body)}
                        {!open && <div aria-hidden="true" style={{ position: "absolute", inset: "auto 0 0 0", height: 48, background: "linear-gradient(transparent, var(--surface))" }} />}
                      </div>
                      {item.body.length > 200 && (
                        <button className="btn btn-sm btn-ghost" style={{ marginTop: "var(--s2)" }} onClick={() => setExpanded(prev => { const n = new Set(prev); n.has(i) ? n.delete(i) : n.add(i); return n; })}>
                          {open ? "Show less" : "Read more"}
                        </button>
                      )}
                    </article>
                  );
                })}
              </div>
            )}
          </section>
        )}

        {!profile.chatEnabled && !profile.feedEnabled && (
          <p className="small soft" style={{ marginTop: "var(--s6)" }}>This agent is live but hasn&apos;t turned on chat or a public feed yet.</p>
        )}

        <footer style={{ marginTop: "var(--s8)", textAlign: "center" }}>
          <a href="/" style={{ color: "var(--ink-muted)", fontSize: "0.8rem", textDecoration: "none" }}>Made with Krelvan</a>
        </footer>
      </div>
    </main>
  );
}

function ChatPanel({ slug, siteKey }: { slug: string; siteKey: string }) {
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  // The conversation thread — in MEMORY only (never localStorage), per the artifacts guidance.
  const threadRef = useRef<string | undefined>(undefined);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => { scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" }); }, [turns]);

  const pollUntilDone = useCallback(async (thread: string) => {
    for (let i = 0; i < 40; i++) {
      await new Promise(r => setTimeout(r, 1500));
      const r = await publicAskPoll(slug, thread);
      if (r.status === "reply") { setTurns(t => [...t, { role: "agent", text: r.reply }]); return; }
      if (r.status === "awaiting-approval") { setTurns(t => [...t, { role: "system", text: "This needs a person to approve before it can reply." }]); return; }
      if (r.status === "error") { setTurns(t => [...t, { role: "system", text: "Sorry — something went wrong." }]); return; }
    }
    setTurns(t => [...t, { role: "system", text: "Still working — try again in a moment." }]);
  }, [slug]);

  async function send() {
    const message = input.trim();
    if (!message || busy) return;
    setInput("");
    setTurns(t => [...t, { role: "you", text: message }]);
    setBusy(true);
    try {
      const r = await publicAsk(slug, message, siteKey, threadRef.current);
      if (r.status === "reply") { threadRef.current = r.thread; setTurns(t => [...t, { role: "agent", text: r.reply }]); }
      else if (r.status === "awaiting-approval") { threadRef.current = r.thread; setTurns(t => [...t, { role: "system", text: "This needs a person to approve before it can reply." }]); }
      else if (r.status === "pending") { threadRef.current = r.thread; await pollUntilDone(r.thread); }
      else if (r.status === "rate-limited") { setTurns(t => [...t, { role: "system", text: "You're sending messages too fast — please slow down." }]); }
      else { setTurns(t => [...t, { role: "system", text: "Sorry — the agent couldn't be reached." }]); }
    } catch { setTurns(t => [...t, { role: "system", text: "Sorry — the agent couldn't be reached." }]); }
    finally { setBusy(false); }
  }

  return (
    <section className="card" style={{ padding: "var(--s5)" }}>
      <div ref={scrollRef} style={{ maxHeight: 380, overflowY: "auto", display: "flex", flexDirection: "column", gap: "var(--s3)", marginBottom: "var(--s4)" }}>
        {turns.length === 0 ? (
          <p className="small soft" style={{ margin: "var(--s3) 0", textAlign: "center" }}>Ask this agent anything.</p>
        ) : turns.map((turn, i) => (
          <div key={i} style={{ alignSelf: turn.role === "you" ? "flex-end" : "flex-start", maxWidth: "82%" }}>
            <div style={{
              padding: "var(--s2) var(--s3)", borderRadius: "var(--r)", lineHeight: 1.55,
              background: turn.role === "you" ? "var(--brand)" : turn.role === "system" ? "var(--surface-sunken)" : "var(--brand-tint)",
              color: turn.role === "you" ? "#fff" : turn.role === "system" ? "var(--ink-muted)" : "var(--ink)",
              fontStyle: turn.role === "system" ? "italic" : "normal",
            }}>
              <span className="small" style={{ whiteSpace: "pre-wrap" }}>{turn.text}</span>
            </div>
          </div>
        ))}
        {busy && <div style={{ alignSelf: "flex-start" }}><span className="small muted"><span className="spinner" aria-hidden="true" style={{ width: 12, height: 12 }} /> thinking…</span></div>}
      </div>
      <form onSubmit={e => { e.preventDefault(); void send(); }} style={{ display: "flex", gap: "var(--s2)" }}>
        <input
          className="input"
          value={input}
          onChange={e => setInput(e.target.value)}
          placeholder="Type a message…"
          aria-label="Message"
          disabled={busy}
          style={{ flex: 1 }}
        />
        <button className="btn btn-primary" type="submit" disabled={busy || !input.trim()}>Send</button>
      </form>
    </section>
  );
}
