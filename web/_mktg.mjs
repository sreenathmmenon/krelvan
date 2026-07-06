import { chromium } from "playwright-core";
import { readFileSync, writeFileSync } from "node:fs";
const WEB="http://localhost:3105", OUTDIR="/Users/sreenath/Code/myAIExps/krelvan-private/agent-tests";
// SCENARIOS: real-world marketing requests in plain language
const SCENARIOS = JSON.parse(process.argv[2]);
const base = JSON.parse(readFileSync("/Users/sreenath/Code/myAIExps/genesis-new/templates/growth-team.manifest.json","utf8"));
const esc=s=>String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");

const b=await chromium.launch({executablePath:"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",headless:true});
const ctx=await b.newContext(); const pg=await ctx.newPage();
await pg.goto(`${WEB}/login`,{waitUntil:"domcontentloaded",timeout:10000}).catch(()=>{}); await pg.waitForTimeout(2000);
await pg.locator('input:not([type="password"]):visible').first().fill("sreenath").catch(()=>{});
await pg.locator('input[type="password"]:visible').first().fill("Krelvan-live-2026!").catch(()=>{});
await pg.getByRole("button",{name:/sign in/i}).click().catch(()=>{}); await pg.waitForTimeout(3000);
const csrf=await pg.evaluate(()=>sessionStorage.getItem("krelvan_csrf"));

const results=[];
for(const sc of SCENARIOS){
  const manifest=JSON.parse(JSON.stringify(base));
  Object.assign(manifest.seed, sc.seed);
  const id=await pg.evaluate(async({manifest,csrf})=>{const r=await fetch("/proxy/api/templates/install",{method:"POST",headers:{"content-type":"application/json","X-CSRF-Token":csrf},body:JSON.stringify({manifest})});return (await r.json()).agent?.id;},{manifest,csrf});
  const rid=await pg.evaluate(async({id,csrf})=>{const r=await fetch("/proxy/api/runs",{method:"POST",headers:{"content-type":"application/json","X-CSRF-Token":csrf},body:JSON.stringify({agentId:id})});const j=await r.json();return j.run?.runId||j.runId;},{id,csrf});
  let st="running";
  for(let i=0;i<120;i++){await pg.waitForTimeout(4000);
    st=await pg.evaluate(async(r)=>{try{const j=await (await fetch(`/proxy/api/runs/${r}`)).json();return j.run?.status||j.status;}catch{return "?";}},rid);
    if(st==="halted"){const appr=await pg.evaluate(async(rid)=>{const j=await (await fetch("/proxy/api/approvals")).json();return (j.approvals||j).find(a=>a.runId===rid);},rid);
      if(appr){await pg.evaluate(async({cid,rid,csrf})=>{await fetch(`/proxy/api/approvals/${encodeURIComponent(cid)}/resolve`,{method:"POST",headers:{"content-type":"application/json","X-CSRF-Token":csrf},body:JSON.stringify({runId:rid,decision:"approve"})});},{cid:appr.correlationId,rid,csrf}); continue;}}
    if(["completed","failed"].includes(st))break;}
  const s=await pg.evaluate(async(r)=>{const j=await (await fetch(`/proxy/api/runs/${r}`)).json();return j.projection?.state||{};},rid);
  const errs=Object.keys(s).filter(k=>k.endsWith('.error')||(k.endsWith('.ok')&&s[k]===false));
  const dkeys=['prospect_outreach.outreach_draft','draft_content.article','draft_content.social','growth_plan.result'];
  const deliverables=dkeys.map(k=>String(s[k]||'')).join(' ');
  // real placeholder = a bracket containing a placeholder WORD (not a [1] citation)
  const brackets=/\[[^\]]*\b(name|company|your name|editor|insert|first name|last name|placeholder|xyz|todo)\b[^\]]*\]/i.test(deliverables);
  const dk=['draft_content.article','prospect_outreach.outreach_draft','growth_plan.result'];
  const empty=dk.filter(k=>!(s[k]&&String(s[k]).trim().length>50));
  results.push({sc, st, errs, brackets, empty, s});
  writeFileSync('/tmp/dbg-'+sc.name.replace(/[^a-z0-9]/gi,'_')+'.json', JSON.stringify({article:s['draft_content.article'],social:s['draft_content.social'],outreach:s['prospect_outreach.outreach_draft'],plan:s['growth_plan.result']},null,2));
  require0: {}
  writeFileSync('/tmp/dbg-'+sc.name.replace(/[^a-z0-9]/gi,'_')+'.json', JSON.stringify({article:s['draft_content.article'],social:s['draft_content.social'],outreach:s['prospect_outreach.outreach_draft']},null,2)); //DBG_DUMP
  console.log(`  ${sc.name}: ${st} | errors:${errs.length} | placeholders:${brackets} | empty-deliverables:${empty.length?empty.join(","):"none"}`);
}
await b.close();

// Build ONE human-readable HTML: plain-English request -> what the agent delivered
const pick=(s,k)=>s[k]!==undefined?String(s[k]):'';
const sections=results.map(r=>{
  const s=r.s; const clean=r.st==='completed'&&r.errs.length===0&&!r.brackets&&(!r.empty||r.empty.length===0);
  return `<div class="scn ${clean?'ok':'bad'}">
  <h2>${esc(r.sc.name)} ${clean?'<span class=badge-ok>✓ PRODUCTION-READY</span>':'<span class=badge-bad>✗ ISSUES</span>'}</h2>
  <div class="req"><b>What the user asked (plain English):</b><br>${esc(r.sc.request)}</div>
  <div class="meta">Status: <b>${esc(r.st)}</b> · Node errors: <b>${r.errs.length?esc(r.errs.join(', ')):'none'}</b> · Placeholders left: <b>${r.brackets?'YES ✗':'none ✓'}</b></div>
  <div class="deliv"><h3>What the marketing agent delivered:</h3>
    <div class="d"><h4>📊 Market research</h4><p>${esc(pick(s,'market_research.findings')||pick(s,'market_research.result')).slice(0,600)}</p></div>
    <div class="d"><h4>🔍 SEO plan (article titles + keywords)</h4><p><b>Titles:</b> ${esc(pick(s,'seo_audit.content_priorities')).slice(0,400)}<br><b>Keywords:</b> ${esc(pick(s,'seo_audit.keyword_gaps')).slice(0,300)}</p></div>
    <div class="d"><h4>✍️ Ready-to-publish article</h4><p>${esc(pick(s,'draft_content.article')).slice(0,900)}</p></div>
    <div class="d"><h4>📱 Social posts</h4><p>${esc(pick(s,'draft_content.social')).slice(0,500)}</p></div>
    <div class="d"><h4>📧 Outreach message</h4><p>${esc(pick(s,'prospect_outreach.outreach_draft')).slice(0,600)}</p></div>
    <div class="d"><h4>🎯 Prioritized growth plan</h4><p>${esc(pick(s,'growth_plan.result')).slice(0,900)}</p></div>
  </div></div>`;
}).join("");
const allClean=results.every(r=>r.st==='completed'&&r.errs.length===0&&!r.brackets&&(!r.empty||r.empty.length===0));
const html=`<!doctype html><meta charset=utf8><title>Marketing Agent — multi-scenario test</title>
<style>body{font:15px system-ui,sans-serif;max-width:920px;margin:2rem auto;padding:0 1rem;color:#1a1a1a;background:#f7f7f8;line-height:1.6}
h1{font-size:1.8rem}.top{padding:1rem 1.4rem;border-radius:10px;margin:1rem 0;font-weight:600}.top.ok{background:#e6f4ea;border:1px solid #34a853}.top.bad{background:#fce8e6;border:1px solid #ea4335}
.scn{background:#fff;border:1px solid #ddd;border-radius:12px;padding:1.5rem;margin:1.5rem 0}.scn.bad{border-color:#ea4335}
.req{background:#eef2ff;border-left:4px solid #4353ff;padding:.8rem 1rem;border-radius:6px;margin:.8rem 0;font-size:1.02rem}
.meta{font-size:.85rem;color:#555;margin:.5rem 0 1rem}
.badge-ok{font-size:.7rem;background:#e6f4ea;color:#137333;padding:3px 9px;border-radius:5px}.badge-bad{font-size:.7rem;background:#fce8e6;color:#c5221f;padding:3px 9px;border-radius:5px}
.d{border-top:1px solid #eee;padding:.7rem 0}.d h4{margin:0 0 .3rem;font-size:.95rem}.d p{margin:0;white-space:pre-wrap;color:#333;font-size:.92rem}
h3{font-size:1.05rem;margin:1rem 0 .3rem}</style>
<h1>Marketing Agent — real-world scenario tests</h1>
<div class="top ${allClean?'ok':'bad'}">${allClean?'✓ ALL SCENARIOS PRODUCTION-READY — completed, zero errors, zero placeholders':'✗ SOME SCENARIOS HAVE ISSUES (see red below)'}</div>
${sections}<p style="color:#999">Model: deepseek-chat (ClinePass). Each scenario: real company site + real goal, run end-to-end through the Krelvan Autonomous Growth Team agent.</p>`;
writeFileSync(`${OUTDIR}/marketing-agent-scenarios.html`, html);
console.log("ALL CLEAN:", allClean, "-> /Users/sreenath/Code/myAIExps/krelvan-private/agent-tests/marketing-agent-scenarios.html");
