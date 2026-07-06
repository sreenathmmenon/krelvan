// Honest full-fleet validation: run every template, READ each deliverable, flag errors/empties.
import { chromium } from "playwright-core";
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
const WEB = "http://localhost:3105";
const TDIR = "/Users/sreenath/Code/myAIExps/genesis-new/templates";
const OUT = "/Users/sreenath/Code/myAIExps/krelvan-private/agent-tests";

// Realistic seeds per template so each has real subject matter (a real user would set these).
const SEEDS = {
  "advisor": {},
  "assistant": { message: "What are the top 3 AI agent frameworks in 2026 and why?", query: "top AI agent frameworks 2026", history: "" },
  "chief-of-staff": { meetings: "2pm Priya Nair, VP Eng at Stripe (platform eval)", query: "Stripe engineering", my_context: "I sell an agentic AI platform" },
  "competitive-intel": { topic: "AI developer tools", query: "AI developer tools competitive landscape 2026" },
  "content-repurposer": { source: "Krelvan turns plain English into real multi-agent systems that research, draft, and act across your tools.", brand_label: "confident, technical", channel: "linkedin" },
  "daily-digest": { query: "latest AI engineering news 2026", topic: "AI engineering news", url: "https://news.ycombinator.com", source_a_label: "AI", source_b_label: "LLM" },
  "growth-team": { url: "https://www.postgresql.org/about/", site_url: "https://www.postgresql.org/about/", query: "PostgreSQL database", product: "PostgreSQL", audience: "engineering teams", goal: "be the obvious database choice" },
  "inbox-triage": { message: "Hi, our API integration is returning 500 errors since this morning, this is urgent, we have customers affected.", from: "acme@example.com" },
  "incident-responder": { alert: "API p99 latency 4200ms, error rate 12%, service payments-api", query: "high latency payments API" },
  "influencer-outreach": { topic: "AI dev tools", query: "top AI developer tool creators", product: "Krelvan" },
  "investment-research": { topic: "AI infrastructure sector", query: "AI infrastructure investment 2026" },
  "kb-ingest": { source_url: "https://www.postgresql.org/about/", url: "https://www.postgresql.org/about/" },
  "kb-wiki-builder": { source: "PostgreSQL is a powerful open-source relational database with strong ACID compliance, extensibility, and SQL standards support.", topic: "PostgreSQL" },
  "lead-qualifier": { lead_url: "https://stripe.com", url: "https://stripe.com", query: "Stripe payments", icp: "fintech companies", from_name: "Sam" },
  "lead-to-outreach": { lead_url: "https://vercel.com", url: "https://vercel.com", query: "Vercel company", company: "Vercel", from_name: "Sam" },
  "order-to-refund": { order_id: "ORD-4821", reason: "item arrived damaged", policy: "refunds allowed within 30 days for damaged goods" },
  "price-monitor": { url: "https://www.amazon.com/dp/B08N5WRWNW", target_url: "https://www.amazon.com/dp/B08N5WRWNW", watch_label: "Echo Dot", threshold: "40" },
  "publish-and-deploy": { query: "static site deploy", content: "A short blog post about self-hosting AI agents." },
  "rag-knowledge": { source_url: "https://www.postgresql.org/about/", url: "https://www.postgresql.org/about/", question: "What is PostgreSQL good at?", query: "PostgreSQL features" },
  "reply-handler": { reply: "Thanks, this looks interesting. Can you send pricing?", context: "outbound sales email about Krelvan" },
  "research-analyst": { topic: "the state of self-hosted AI platforms", query: "self-hosted AI platforms", audience: "a technical founder" },
  "set-context": { name: "Sreenath", goals: "launch Krelvan", principles: "ship production-grade" },
  "social-voice": { niche: "applied AI for engineering teams", query: "applied AI engineering 2026", brand_voice: "confident, technical", audience: "engineering leaders", channel: "LinkedIn" },
  "supervisor-delegation": { task: "research and summarize the best AI agent frameworks", query: "AI agent frameworks 2026" },
  "support-agent": { message: "I was double-charged for my subscription this month, please help.", from: "user@example.com" },
  "support-bot": { question: "How do I reset my password?", source_url: "https://www.postgresql.org/docs/", url: "https://www.postgresql.org/docs/" },
  "wiki-ask": { question: "What is PostgreSQL?", query: "PostgreSQL" },
  "wiki-ingest": { source: "PostgreSQL is an advanced open-source relational database.", topic: "PostgreSQL" },
};

const b = await chromium.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
const pg = await (await b.newContext()).newPage();
await pg.goto(`${WEB}/login`, { waitUntil: "domcontentloaded", timeout: 10000 }).catch(() => {});
await pg.waitForTimeout(2500);
await pg.locator('input:not([type="password"]):visible').first().fill("sreenath").catch(() => {});
await pg.locator('input[type="password"]:visible').first().fill("Krelvan-live-2026!").catch(() => {});
await pg.getByRole("button", { name: /sign in/i }).click().catch(() => {});
await pg.waitForTimeout(3500);
const csrf = await pg.evaluate(() => sessionStorage.getItem("krelvan_csrf"));

const templates = readdirSync(TDIR).filter(f => f.endsWith(".manifest.json")).map(f => f.replace(".manifest.json", ""));
const results = [];

for (const t of templates) {
  const m = JSON.parse(readFileSync(`${TDIR}/${t}.manifest.json`, "utf8"));
  Object.assign(m.seed = m.seed || {}, SEEDS[t] || {});
  let verdict = "FAIL", detail = "", sample = "";
  try {
    const id = await pg.evaluate(async ({ m, csrf }) => {
      const r = await fetch("/proxy/api/templates/install", { method: "POST", headers: { "content-type": "application/json", "X-CSRF-Token": csrf }, body: JSON.stringify({ manifest: m }) });
      return (await r.json()).agent?.id;
    }, { m, csrf });
    const rid = await pg.evaluate(async ({ id, csrf }) => {
      const r = await fetch("/proxy/api/runs", { method: "POST", headers: { "content-type": "application/json", "X-CSRF-Token": csrf }, body: JSON.stringify({ agentId: id }) });
      return (await r.json()).run?.runId;
    }, { id, csrf });
    let st = "running";
    for (let i = 0; i < 40; i++) {
      await pg.waitForTimeout(3000);
      const j = await pg.evaluate(async (r) => { try { return await (await fetch(`/proxy/api/runs/${r}`)).json(); } catch { return {}; } }, rid);
      st = j.run?.status || "?";
      if (st === "halted") {
        // auto-approve so we see the full deliverable
        const appr = await pg.evaluate(async (rid) => { const j = await (await fetch("/proxy/api/approvals")).json(); return (j.approvals || j).find(a => a.runId === rid); }, rid);
        if (appr) { await pg.evaluate(async ({ cid, rid, csrf }) => { await fetch(`/proxy/api/approvals/${encodeURIComponent(cid)}/resolve`, { method: "POST", headers: { "content-type": "application/json", "X-CSRF-Token": csrf }, body: JSON.stringify({ runId: rid, decision: "approve" }) }); }, { cid: appr.correlationId, rid, csrf }); continue; }
      }
      if (["completed", "failed"].includes(st)) break;
    }
    // READ THE ACTUAL DELIVERABLE STATE
    const state = await pg.evaluate(async (r) => { const j = await (await fetch(`/proxy/api/runs/${r}`)).json(); return j.projection?.state || {}; }, rid);
    // Find prose deliverables + detect errors/empties by READING content
    const errs = [];
    const deliverables = [];
    for (const [k, v] of Object.entries(state)) {
      if (typeof v !== "string") continue;
      if (k.endsWith(".error") && v.trim()) errs.push(`${k}: ${v.slice(0, 80)}`);
      // is this a deliverable key with real content?
      if (/\.(result|body|reply|answer|summary|digest|briefing|post|final_post|article|message|brief|response|plan|draft)$/.test(k)) {
        const txt = v.trim();
        // detect an error-message masquerading as output
        if (/unable to|failed|no query|could not|error:|cannot |i'm sorry|as an ai/i.test(txt) && txt.length < 300) {
          errs.push(`${k} is an error message: "${txt.slice(0, 100)}"`);
        } else if (txt.length > 40) {
          deliverables.push({ k, txt });
        }
      }
    }
    if (errs.length > 0) { verdict = "FAIL"; detail = errs.join(" | "); }
    else if (deliverables.length === 0) { verdict = "EMPTY"; detail = `status ${st}, no prose deliverable`; }
    else { verdict = "PASS"; detail = `${deliverables.length} deliverable(s)`; sample = deliverables[0].txt.slice(0, 200); }
    if (st === "failed") { verdict = "FAIL"; detail = "run failed. " + detail; }
  } catch (e) { verdict = "ERROR"; detail = String(e).slice(0, 100); }
  results.push({ agent: t, verdict, detail, sample });
  console.log(`${verdict === "PASS" ? "✓" : "✗"} ${t}: ${verdict} — ${detail}`);
}
writeFileSync(`${OUT}/_HONEST_FLEET.json`, JSON.stringify(results, null, 2));
const pass = results.filter(r => r.verdict === "PASS").length;
console.log(`\n═══ ${pass}/${results.length} PASS (real deliverable, no errors) ═══`);
console.log("FAILING:", results.filter(r => r.verdict !== "PASS").map(r => r.agent).join(", "));
await b.close();
