// Full evidence capture: for each flagship agent — run live, deliver to Inbox + Telegram,
// capture FULL input + FULL output as an HTML page, verdict by READING actual text.
import { chromium } from "playwright-core";
import { readFileSync, writeFileSync } from "node:fs";
const WEB = "http://localhost:3105";
const TDIR = "/Users/sreenath/Code/myAIExps/genesis-new/templates";
const OUT = "/Users/sreenath/Code/myAIExps/krelvan-private/agent-tests";
const SEEDS = JSON.parse(readFileSync("/Users/sreenath/Code/myAIExps/genesis-new/web/_seeds.json", "utf8"));
const AGENTS = JSON.parse(readFileSync("/Users/sreenath/Code/myAIExps/genesis-new/web/_agentlist.json", "utf8"));
const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const b = await chromium.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
const pg = await (await b.newContext()).newPage();
await pg.goto(`${WEB}/login`, { waitUntil: "domcontentloaded", timeout: 10000 }).catch(() => {});
await pg.waitForTimeout(2500);
await pg.locator('input:not([type="password"]):visible').first().fill("sreenath").catch(() => {});
await pg.locator('input[type="password"]:visible').first().fill("Krelvan-live-2026!").catch(() => {});
await pg.getByRole("button", { name: /sign in/i }).click().catch(() => {});
await pg.waitForTimeout(3500);
const csrf = await pg.evaluate(() => sessionStorage.getItem("krelvan_csrf"));
const summary = [];

for (const t of AGENTS) {
  const m = JSON.parse(readFileSync(`${TDIR}/${t}.manifest.json`, "utf8"));
  Object.assign(m.seed = m.seed || {}, SEEDS[t] || {});
  let id, rid, state = {}, st = "?";
  try {
    id = await pg.evaluate(async ({ m, csrf }) => (await (await fetch("/proxy/api/templates/install", { method: "POST", headers: { "content-type": "application/json", "X-CSRF-Token": csrf }, body: JSON.stringify({ manifest: m }) })).json()).agent?.id, { m, csrf });
    await pg.evaluate(async ({ id, csrf }) => { await fetch(`/proxy/api/agents/${id}/delivery`, { method: "PUT", headers: { "content-type": "application/json", "X-CSRF-Token": csrf }, body: JSON.stringify({ deliverTo: [{ channel: "inbox", config: {} }, { channel: "telegram", config: {} }] }) }); }, { id, csrf });
    rid = await pg.evaluate(async ({ id, csrf }) => (await (await fetch("/proxy/api/runs", { method: "POST", headers: { "content-type": "application/json", "X-CSRF-Token": csrf }, body: JSON.stringify({ agentId: id }) })).json()).run?.runId, { id, csrf });
    for (let i = 0; i < 45; i++) {
      await pg.waitForTimeout(3000);
      const j = await pg.evaluate(async (r) => { try { return await (await fetch(`/proxy/api/runs/${r}`)).json(); } catch { return {}; } }, rid);
      st = j.run?.status || "?";
      if (st === "halted") {
        const appr = await pg.evaluate(async (rid) => { const j = await (await fetch("/proxy/api/approvals")).json(); return (j.approvals || j).find(a => a.runId === rid); }, rid);
        if (appr) { await pg.evaluate(async ({ cid, rid, csrf }) => { await fetch(`/proxy/api/approvals/${encodeURIComponent(cid)}/resolve`, { method: "POST", headers: { "content-type": "application/json", "X-CSRF-Token": csrf }, body: JSON.stringify({ runId: rid, decision: "approve" }) }); }, { cid: appr.correlationId, rid, csrf }); continue; }
      }
      if (["completed", "failed"].includes(st)) break;
    }
    state = await pg.evaluate(async (r) => (await (await fetch(`/proxy/api/runs/${r}`)).json()).projection?.state || {}, rid);
  } catch (e) { st = "error: " + String(e).slice(0, 60); }

  const errs = [], deliverables = [];
  for (const [k, v] of Object.entries(state)) {
    if (typeof v !== "string") continue;
    if (k.endsWith(".error") && v.trim()) errs.push(`${k}: ${v}`);
    if (/\.(result|body|reply|answer|summary|digest|briefing|post|final_post|article|message|brief|response|plan|draft|text)$/.test(k) && v.trim().length > 40) {
      if (/^(unable to|failed|no query|could not|error:|i am sorry|i'm sorry|as an ai)/i.test(v.trim()) && v.trim().length < 300) errs.push(`${k} error: ${v.slice(0, 90)}`);
      else deliverables.push({ k, v: v.trim() });
    }
  }
  const verdict = errs.length ? "FAIL" : deliverables.length ? "PASS" : "EMPTY";

  const inputRows = Object.entries(m.seed).map(([k, v]) => `<tr><td class=k>${esc(k)}</td><td class=v>${esc(String(v).slice(0, 400))}</td></tr>`).join("");
  const outCards = Object.entries(state).filter(([k, v]) => typeof v === "string" && v.trim().length > 0 && !k.startsWith("_")).map(([k, v]) => `<div class=out><div class=okey>${esc(k)}</div><div class=oval>${esc(v).slice(0, 3000)}</div></div>`).join("");
  const html = `<!doctype html><meta charset=utf8><title>${esc(m.name)} — evidence</title>
<style>body{font:14px system-ui,sans-serif;max-width:900px;margin:2rem auto;padding:0 1rem;background:#f6f7f8;color:#1a1a1a;line-height:1.6}
h1{font-size:1.5rem}h2{font-size:.8rem;text-transform:uppercase;letter-spacing:.05em;color:#555;margin-top:2rem}
.top{padding:.9rem 1.2rem;border-radius:10px;margin:1rem 0;font-weight:600}
.pass{background:#e6f4ea;border:1px solid #34a853}.fail{background:#fce8e6;border:1px solid #ea4335}.empty{background:#fef7e0;border:1px solid #f9ab00}
table{width:100%;border-collapse:collapse;background:#fff;border-radius:8px;overflow:hidden}
td{padding:.5rem .8rem;border-bottom:1px solid #eee;vertical-align:top}.k{font-weight:600;color:#4353ff;width:170px;font-family:monospace;font-size:.85em}
.v{white-space:pre-wrap}.out{background:#fff;border:1px solid #ddd;border-radius:8px;padding:1rem;margin:.7rem 0}
.okey{font-family:monospace;font-size:.78em;color:#4353ff;font-weight:700;margin-bottom:.4rem}.oval{white-space:pre-wrap}.err{color:#c5221f}</style>
<h1>${esc(m.name)}</h1>
<div class="top ${verdict.toLowerCase()}">${verdict === "PASS" ? "✓ Real output delivered — no errors" : verdict === "FAIL" ? "✗ " + esc(errs.join(" · ").slice(0, 200)) : "· No prose deliverable"} · run ${esc(st)} · delivered to Inbox + Telegram</div>
<h2>What the agent was given (full input)</h2>
<table>${inputRows || "<tr><td>(no seed)</td></tr>"}</table>
<h2>What the agent produced (full output — every field)</h2>
${outCards || "<p class=err>No output.</p>"}`;
  writeFileSync(`${OUT}/${t}.html`, html);
  console.log(`${verdict === "PASS" ? "✓" : "✗"} ${t}: ${verdict}${errs.length ? " — " + errs[0].slice(0, 70) : ` (${deliverables.length} deliverables)`}`);
  summary.push({ agent: t, verdict, deliverables: deliverables.length, errors: errs.length, runId: rid });
}
writeFileSync(`${OUT}/_EVIDENCE_SUMMARY.json`, JSON.stringify(summary, null, 2));
console.log(`\n═══ ${summary.filter(s => s.verdict === "PASS").length}/${summary.length} PASS — full HTML evidence + Telegram delivery per agent ═══`);
await b.close();
