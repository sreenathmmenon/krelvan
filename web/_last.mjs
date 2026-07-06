import { chromium } from "playwright-core";
import { readFileSync } from "node:fs";
const WEB="http://localhost:3105", SHOTS="/Users/sreenath/Code/myAIExps/krelvan-private/screenshots";
const manifest=JSON.parse(readFileSync("/Users/sreenath/Code/myAIExps/genesis-new/templates/assistant.manifest.json","utf8"));
const b=await chromium.launch({executablePath:"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",headless:true});
const pg=await (await b.newContext({viewport:{width:1440,height:1100},deviceScaleFactor:2})).newPage();
await pg.goto(`${WEB}/login`,{waitUntil:"domcontentloaded",timeout:10000}).catch(()=>{}); await pg.waitForTimeout(2500);
await pg.locator('input:not([type="password"]):visible').first().fill("sreenath").catch(()=>{});
await pg.locator('input[type="password"]:visible').first().fill("Krelvan-live-2026!").catch(()=>{});
await pg.getByRole("button",{name:/sign in/i}).click().catch(()=>{}); await pg.waitForTimeout(3500);
const csrf=await pg.evaluate(()=>sessionStorage.getItem("krelvan_csrf"));
const id=await pg.evaluate(async({manifest,csrf})=>{const r=await fetch("/proxy/api/templates/install",{method:"POST",headers:{"content-type":"application/json","X-CSRF-Token":csrf},body:JSON.stringify({manifest})});return (await r.json()).agent?.id;},{manifest,csrf});
console.log("agent:",id?.slice(-8));
await pg.goto(`${WEB}/agents/${id}`,{waitUntil:"domcontentloaded",timeout:12000}).catch(()=>{}); await pg.waitForTimeout(2500);
// verify page loaded (not the error page)
const loaded=await pg.evaluate(()=>document.body.innerText.includes("Chat")&&!document.body.innerText.includes("isn't here"));
console.log("page loaded ok:",loaded);
if(loaded){
  await pg.getByRole("tab",{name:"Chat"}).click().catch(async()=>{await pg.getByText("Chat",{exact:true}).first().click().catch(()=>{});});
  await pg.waitForTimeout(1500);
  const ta=pg.locator('textarea, input[type="text"]').last();
  await ta.click().catch(()=>{});
  await ta.fill("Give me 3 sharp LinkedIn post ideas about AI agents for engineering leaders.").catch(()=>{});
  await pg.getByRole("button",{name:/^send$/i}).click().catch(()=>pg.keyboard.press("Enter"));
  // wait for reply — poll the chat log content
  for(let i=0;i<18;i++){await pg.waitForTimeout(2500); const ok=await pg.evaluate(()=>{const t=document.body.innerText; return (t.match(/idea|post|1\./gi)||[]).length>2 && t.length>2000;}); if(ok)break;}
  await pg.waitForTimeout(2000);
  await pg.evaluate(()=>window.scrollTo(0,document.body.scrollHeight));
}
await pg.screenshot({path:`${SHOTS}/feature-chat.png`,fullPage:true});
console.log("final text len:", await pg.evaluate(()=>document.body.innerText.length));
await b.close();
