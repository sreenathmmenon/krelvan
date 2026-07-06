import { chromium } from "playwright-core";
import { readFileSync, writeFileSync } from "node:fs";
const WEB="http://localhost:3105";
const tmpl = process.argv[2];              // template name
const seedOverride = JSON.parse(process.argv[3]||"{}");
const manifest = JSON.parse(readFileSync(`/Users/sreenath/Code/myAIExps/genesis-new/templates/${tmpl}.manifest.json`,"utf8"));
Object.assign(manifest.seed, seedOverride);
const b=await chromium.launch({executablePath:"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",headless:true});
const pg=await (await b.newContext()).newPage();
await pg.goto(`${WEB}/login`,{waitUntil:"domcontentloaded",timeout:10000}).catch(()=>{}); await pg.waitForTimeout(2000);
await pg.locator('input:not([type="password"]):visible').first().fill("sreenath").catch(()=>{});
await pg.locator('input[type="password"]:visible').first().fill("Krelvan-live-2026!").catch(()=>{});
await pg.getByRole("button",{name:/sign in/i}).click().catch(()=>{}); await pg.waitForTimeout(3000);
const csrf=await pg.evaluate(()=>sessionStorage.getItem("krelvan_csrf"));
if(!csrf){console.log(JSON.stringify({tmpl,error:"login failed"}));await b.close();process.exit(2);}
const id=await pg.evaluate(async({manifest,csrf})=>{const r=await fetch("/proxy/api/templates/install",{method:"POST",headers:{"content-type":"application/json","X-CSRF-Token":csrf},body:JSON.stringify({manifest})});const j=await r.json();return j.agent?.id||("ERR:"+JSON.stringify(j).slice(0,120));},{manifest,csrf});
if(String(id).startsWith("ERR")){console.log(JSON.stringify({tmpl,installError:id}));await b.close();process.exit(3);}
const rid=await pg.evaluate(async({id,csrf})=>{const r=await fetch("/proxy/api/runs",{method:"POST",headers:{"content-type":"application/json","X-CSRF-Token":csrf},body:JSON.stringify({agentId:id})});const j=await r.json();return j.run?.runId||j.runId;},{id,csrf});
let st="running", approvals=0;
for(let i=0;i<70;i++){await pg.waitForTimeout(4000);
  st=await pg.evaluate(async(r)=>{const j=await (await fetch(`/proxy/api/runs/${r}`)).json();return j.run?.status||j.status;},rid);
  if(st==="halted"){ // approve the gate to let it finish, so we see the whole run
    const appr=await pg.evaluate(async(rid)=>{const j=await (await fetch("/proxy/api/approvals")).json();return (j.approvals||j).find(a=>a.runId===rid);},rid);
    if(appr){approvals++;await pg.evaluate(async({cid,rid,csrf})=>{await fetch(`/proxy/api/approvals/${encodeURIComponent(cid)}/resolve`,{method:"POST",headers:{"content-type":"application/json","X-CSRF-Token":csrf},body:JSON.stringify({runId:rid,decision:"approve"})});},{cid:appr.correlationId,rid,csrf}); continue;}
  }
  if(["completed","failed"].includes(st))break;}
const s=await pg.evaluate(async(r)=>{const j=await (await fetch(`/proxy/api/runs/${r}`)).json();return {state:j.projection?.state||{}, reason:j.run?.reason};},rid);
const errs=Object.entries(s.state).filter(([k,v])=>(k.endsWith('.ok')&&v===false)||k.endsWith('.error')).map(([k,v])=>`${k}=${v}`);
const nodes=[...new Set(Object.keys(s.state).map(k=>k.split(".")[0]))];
writeFileSync(`/tmp/verify-${tmpl}.json`, JSON.stringify(s.state,null,2));
console.log(JSON.stringify({tmpl, status:st, reason:s.reason, approvals, nodesWithOutput:nodes.length, errors:errs, stateKeys:Object.keys(s.state).length}));
await b.close();
