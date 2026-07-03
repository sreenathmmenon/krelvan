import { chromium } from "playwright-core";
import { readFileSync } from "node:fs";
const WEB="http://localhost:3105", U="sreenath", P="Krelvan-live-2026!";
const b=await chromium.launch({executablePath:"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",headless:true});
const pg=await (await b.newContext()).newPage();
await pg.goto(`${WEB}/login`,{waitUntil:"domcontentloaded",timeout:9000}).catch(()=>{}); await pg.waitForTimeout(2500);
await pg.locator('input:not([type="password"]):visible').first().fill(U).catch(()=>{});
await pg.locator('input[type="password"]:visible').first().fill(P).catch(()=>{});
await pg.getByRole("button",{name:/sign in/i}).click().catch(()=>{}); await pg.waitForTimeout(3500);
const csrf=await pg.evaluate(()=>sessionStorage.getItem("krelvan_csrf"));
for(const t of ["investment-research","support-agent"]){
  const manifest=JSON.parse(readFileSync(`/tmp/manifests/${t}.manifest.json`,"utf8"));
  const id=await pg.evaluate(async({manifest,csrf})=>{const r=await fetch("/proxy/api/templates/install",{method:"POST",headers:{"content-type":"application/json","X-CSRF-Token":csrf},body:JSON.stringify({manifest})});return (await r.json()).agent?.id;},{manifest,csrf});
  const rid=await pg.evaluate(async({id,csrf})=>{const r=await fetch("/proxy/api/runs",{method:"POST",headers:{"content-type":"application/json","X-CSRF-Token":csrf},body:JSON.stringify({agentId:id})});const j=await r.json();return j.run?.runId||j.runId;},{id,csrf});
  let st="running"; for(let i=0;i<30;i++){ await pg.waitForTimeout(3000); st=await pg.evaluate(async(x)=>{const j=await (await fetch(`/proxy/api/runs/${x}`)).json();return j.run?.status||j.status;},rid); if(["completed","failed","halted"].includes(st))break; }
  console.log(`${t}: ${st}`);
}
await b.close();
