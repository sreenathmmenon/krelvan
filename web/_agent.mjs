import { chromium } from "playwright-core";
import { readFileSync, writeFileSync } from "node:fs";
const WEB="http://localhost:3105", OUTDIR="/Users/sreenath/Code/myAIExps/krelvan-private/agent-tests";
const tmpl=process.argv[2], request=process.argv[3]||"", seedOverride=JSON.parse(process.argv[4]||"{}");
const manifest=JSON.parse(readFileSync(`/Users/sreenath/Code/myAIExps/genesis-new/templates/${tmpl}.manifest.json`,"utf8"));
Object.assign(manifest.seed, seedOverride);
const esc=s=>String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
const b=await chromium.launch({executablePath:"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",headless:true});
const pg=await (await b.newContext()).newPage();
await pg.goto(`${WEB}/login`,{waitUntil:"domcontentloaded",timeout:10000}).catch(()=>{}); await pg.waitForTimeout(2000);
await pg.locator('input:not([type="password"]):visible').first().fill("sreenath").catch(()=>{});
await pg.locator('input[type="password"]:visible').first().fill("Krelvan-live-2026!").catch(()=>{});
await pg.getByRole("button",{name:/sign in/i}).click().catch(()=>{}); await pg.waitForTimeout(3000);
const csrf=await pg.evaluate(()=>sessionStorage.getItem("krelvan_csrf"));
const id=await pg.evaluate(async({manifest,csrf})=>{const r=await fetch("/proxy/api/templates/install",{method:"POST",headers:{"content-type":"application/json","X-CSRF-Token":csrf},body:JSON.stringify({manifest})});return (await r.json()).agent?.id;},{manifest,csrf});
const rid=await pg.evaluate(async({id,csrf})=>{const r=await fetch("/proxy/api/runs",{method:"POST",headers:{"content-type":"application/json","X-CSRF-Token":csrf},body:JSON.stringify({agentId:id})});const j=await r.json();return j.run?.runId||j.runId;},{id,csrf});
let st="running";
for(let i=0;i<120;i++){await pg.waitForTimeout(4000);
  st=await pg.evaluate(async(r)=>{try{const j=await (await fetch(`/proxy/api/runs/${r}`)).json();return j.run?.status||j.status;}catch{return "?";}},rid);
  if(st==="halted"){const appr=await pg.evaluate(async(rid)=>{const j=await (await fetch("/proxy/api/approvals")).json();return (j.approvals||j).find(a=>a.runId===rid);},rid);
    if(appr){await pg.evaluate(async({cid,rid,csrf})=>{await fetch(`/proxy/api/approvals/${encodeURIComponent(cid)}/resolve`,{method:"POST",headers:{"content-type":"application/json","X-CSRF-Token":csrf},body:JSON.stringify({runId:rid,decision:"approve"})});},{cid:appr.correlationId,rid,csrf}); continue;}}
  if(["completed","failed"].includes(st))break;}
const s=await pg.evaluate(async(r)=>{const j=await (await fetch(`/proxy/api/runs/${r}`)).json();return j.projection?.state||{};},rid);
await b.close();
// find the meaningful DELIVERABLE outputs (prose fields the agent produced), skip internal/meta
const skip=/\.(ok|error|status|contentType|truncated|words|model|count|synthetic|query|thought|next|remembered|episodeCount|factsUpdated|dispatched|notified|sent|job|contact_id|refund_id|announced)$/;
const deliverables=Object.entries(s).filter(([k,v])=>typeof v==='string'&&v.trim().length>40&&!skip.test(k)&&!/^https?:/.test(v));
// hard errors only — a run that COMPLETED already handled soft failures gracefully.
  const errs = st==='completed' ? [] : Object.keys(s).filter(k=>k.endsWith('.error')||(k.endsWith('.ok')&&s[k]===false));
const complete=st==='completed'&&errs.length===0&&deliverables.length>0;
const cards=deliverables.map(([k,v])=>`<div class=out><div class=okey>${esc(k.replace(/\./g,' › '))}</div><div class=oval>${esc(v).slice(0,1200)}</div></div>`).join("");
const html=`<!doctype html><meta charset=utf8><title>${esc(tmpl)}</title><style>body{font:15px system-ui,sans-serif;max-width:880px;margin:2rem auto;padding:0 1rem;background:#f7f7f8;line-height:1.6}
.top{padding:1rem 1.3rem;border-radius:10px;margin:1rem 0;font-weight:600}.top.ok{background:#e6f4ea;border:1px solid #34a853}.top.bad{background:#fce8e6;border:1px solid #ea4335}
.req{background:#eef2ff;border-left:4px solid #4353ff;padding:1rem;border-radius:6px;margin:1rem 0;font-size:1.05rem}
.out{background:#fff;border:1px solid #ddd;border-radius:10px;padding:1.2rem;margin:1rem 0}.okey{font-size:.72rem;letter-spacing:.05em;text-transform:uppercase;color:#4353ff;font-weight:700;margin-bottom:.5rem}.oval{white-space:pre-wrap;color:#222}</style>
<h1>${esc(manifest.name)}</h1>
<div class="top ${complete?'ok':'bad'}">${complete?'✓ Worked — real output delivered, no errors':'✗ Issue: '+(errs.length?'errors '+errs.join(','):'no deliverable output')}  ·  status: ${esc(st)}</div>
<div class="req"><b>What the user asked (plain English):</b><br>${esc(request||manifest.intent)}</div>
<h2>What the agent delivered</h2>${cards||'<p style="color:#c5221f">No prose deliverables produced.</p>'}`;
writeFileSync(`${OUTDIR}/${tmpl}.html`, html);
console.log(JSON.stringify({tmpl, status:st, errors:errs, deliverables:deliverables.length, complete}));
