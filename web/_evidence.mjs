import { chromium } from "playwright-core";
import { readFileSync, writeFileSync } from "node:fs";
const WEB="http://localhost:3105";
const tmpl = process.argv[2];
const seedOverride = JSON.parse(process.argv[3]||"{}");
const OUTDIR = "/Users/sreenath/Code/myAIExps/krelvan-private/agent-tests";
const manifest = JSON.parse(readFileSync(`/Users/sreenath/Code/myAIExps/genesis-new/templates/${tmpl}.manifest.json`,"utf8"));
Object.assign(manifest.seed, seedOverride);
const esc = s => String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");

const b=await chromium.launch({executablePath:"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",headless:true});
const pg=await (await b.newContext()).newPage();
await pg.goto(`${WEB}/login`,{waitUntil:"domcontentloaded",timeout:10000}).catch(()=>{}); await pg.waitForTimeout(2000);
await pg.locator('input:not([type="password"]):visible').first().fill("sreenath").catch(()=>{});
await pg.locator('input[type="password"]:visible').first().fill("Krelvan-live-2026!").catch(()=>{});
await pg.getByRole("button",{name:/sign in/i}).click().catch(()=>{}); await pg.waitForTimeout(3000);
const csrf=await pg.evaluate(()=>sessionStorage.getItem("krelvan_csrf"));
const id=await pg.evaluate(async({manifest,csrf})=>{const r=await fetch("/proxy/api/templates/install",{method:"POST",headers:{"content-type":"application/json","X-CSRF-Token":csrf},body:JSON.stringify({manifest})});return (await r.json()).agent?.id;},{manifest,csrf});
const rid=await pg.evaluate(async({id,csrf})=>{const r=await fetch("/proxy/api/runs",{method:"POST",headers:{"content-type":"application/json","X-CSRF-Token":csrf},body:JSON.stringify({agentId:id})});const j=await r.json();return j.run?.runId||j.runId;},{id,csrf});
let st="running", approvals=0;
for(let i=0;i<120;i++){await pg.waitForTimeout(4000);
  st=await pg.evaluate(async(r)=>{const j=await (await fetch(`/proxy/api/runs/${r}`)).json();return j.run?.status||j.status;},rid);
  if(st==="halted"){const appr=await pg.evaluate(async(rid)=>{const j=await (await fetch("/proxy/api/approvals")).json();return (j.approvals||j).find(a=>a.runId===rid);},rid);
    if(appr){approvals++;await pg.evaluate(async({cid,rid,csrf})=>{await fetch(`/proxy/api/approvals/${encodeURIComponent(cid)}/resolve`,{method:"POST",headers:{"content-type":"application/json","X-CSRF-Token":csrf},body:JSON.stringify({runId:rid,decision:"approve"})});},{cid:appr.correlationId,rid,csrf}); continue;}}
  if(["completed","failed"].includes(st))break;}
const data=await pg.evaluate(async(r)=>{const j=await (await fetch(`/proxy/api/runs/${r}`)).json();return {state:j.projection?.state||{}, reason:j.run?.reason, model:j.run?.model};},rid);
await b.close();

const s=data.state;
const errs=Object.entries(s).filter(([k,v])=>(k.endsWith('.ok')&&v===false)||k.endsWith('.error'));
const nodes=[...new Set(Object.keys(s).map(k=>k.split(".")[0]))];
// group state by node
const byNode={};
for(const [k,v] of Object.entries(s)){const n=k.split(".")[0]; (byNode[n]=byNode[n]||[]).push([k,v]);}

const nodeHtml = nodes.map(n=>{
  const rows=(byNode[n]||[]).map(([k,v])=>`<tr><td class="k">${esc(k)}</td><td class="v"><pre>${esc(typeof v==='object'?JSON.stringify(v,null,2):v)}</pre></td></tr>`).join("");
  const nodeErr=(byNode[n]||[]).some(([k,v])=>(k.endsWith('.ok')&&v===false)||k.endsWith('.error'));
  return `<section class="node ${nodeErr?'err':'ok'}"><h3>${esc(n)} ${nodeErr?'<span class="badge b-err">ERROR</span>':'<span class="badge b-ok">OK</span>'}</h3><table>${rows}</table></section>`;
}).join("");

const html=`<!doctype html><meta charset=utf8><title>${esc(tmpl)} — agent test</title>
<style>body{font:14px -apple-system,system-ui,sans-serif;max-width:1000px;margin:2rem auto;padding:0 1rem;color:#1a1a1a;background:#fafafa}
h1{font-size:1.6rem} h2{margin-top:2rem;border-bottom:2px solid #333;padding-bottom:.3rem}
.summary{padding:1rem;border-radius:8px;margin:1rem 0}
.pass{background:#e6f4ea;border:1px solid #34a853} .fail{background:#fce8e6;border:1px solid #ea4335}
.node{background:#fff;border:1px solid #ddd;border-radius:8px;margin:1rem 0;padding:1rem} .node.err{border-color:#ea4335;background:#fff6f5}
h3{font-size:1.05rem;margin:0 0 .5rem} .badge{font-size:.7rem;padding:2px 8px;border-radius:4px;font-weight:700} .b-ok{background:#e6f4ea;color:#137333} .b-err{background:#fce8e6;color:#c5221f}
table{width:100%;border-collapse:collapse} td{border-top:1px solid #eee;padding:.5rem;vertical-align:top}
.k{font-family:monospace;font-size:.8rem;color:#666;width:200px;word-break:break-all} .v pre{margin:0;white-space:pre-wrap;font-family:inherit;font-size:.9rem;line-height:1.5}
pre.seed{background:#f4f4f4;padding:1rem;border-radius:6px;overflow-x:auto;font-size:.8rem}</style>
<h1>Agent test: <code>${esc(tmpl)}</code></h1>
<div class="summary ${st==='completed'&&errs.length===0?'pass':'fail'}">
  <b>Status:</b> ${esc(st)} ${data.reason?'· '+esc(data.reason):''}<br>
  <b>Node errors:</b> ${errs.length===0?'NONE ✓':esc(JSON.stringify(errs))}<br>
  <b>Model:</b> ${esc(data.model||'z-ai/glm-4.6 (ClinePass)')} · <b>Nodes:</b> ${nodes.length} · <b>Approvals:</b> ${approvals} · <b>Verdict:</b> ${st==='completed'&&errs.length===0?'<b style="color:#137333">COMPLETE — all nodes ran, no errors</b>':'<b style="color:#c5221f">NOT COMPLETE</b>'}
</div>
<h2>INPUT (what the agent was given)</h2>
<pre class="seed">${esc(JSON.stringify(manifest.seed,null,2))}</pre>
<h2>OUTPUT (every node, full)</h2>
${nodeHtml}
<p style="color:#999;margin-top:3rem">Generated by Krelvan agent-test evidence harness. Run id: ${esc(rid)}.</p>`;
const path=`${OUTDIR}/${tmpl}.html`;
writeFileSync(path, html);
console.log(JSON.stringify({tmpl, status:st, errors:errs.map(([k])=>k), verdict:(st==='completed'&&errs.length===0)?'COMPLETE':'NOT COMPLETE', html:path}));
