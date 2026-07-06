import { chromium } from "playwright-core";
import { mkdirSync, rmSync } from "node:fs";
const WEB="http://localhost:3105";
const b=await chromium.launch({executablePath:"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",headless:true});
const pg=await (await b.newContext({viewport:{width:1100,height:720},deviceScaleFactor:1.5})).newPage();
await pg.goto(`${WEB}/login`,{waitUntil:"domcontentloaded",timeout:10000}).catch(()=>{}); await pg.waitForTimeout(2500);
await pg.locator('input:not([type="password"]):visible').first().fill("sreenath").catch(()=>{});
await pg.locator('input[type="password"]:visible').first().fill("Krelvan-live-2026!").catch(()=>{});
await pg.getByRole("button",{name:/sign in/i}).click().catch(()=>{}); await pg.waitForTimeout(3500);
const id=await pg.evaluate(async()=>{const j=await (await fetch("/proxy/api/agents")).json();const a=(j.agents||j).find(x=>/Assistant/.test(x.signed?.manifest?.name||x.name||""));return a?.id;});
if(!id){console.log("no assistant agent");await b.close();process.exit(0);}
const FR="/tmp/gifframes/chat"; rmSync(FR,{recursive:true,force:true}); mkdirSync(FR,{recursive:true});
let f=0; const shot=async()=>{await pg.screenshot({path:`${FR}/${String(f++).padStart(3,'0')}.png`});};
await pg.goto(`${WEB}/agents/${id}`,{waitUntil:"domcontentloaded",timeout:12000}).catch(()=>{}); await pg.waitForTimeout(2500);
await pg.getByText(/^Chat$/).first().click().catch(async()=>{await pg.evaluate(()=>{const t=[...document.querySelectorAll('button,[role=tab]')].find(e=>e.textContent.trim()==='Chat');t&&t.click();});});
await pg.waitForTimeout(1500);
await pg.evaluate(()=>window.scrollTo(0,document.body.scrollHeight)); await pg.waitForTimeout(500);
await shot();await shot();
// type a message char-by-char (captured as frames)
const q="What are the top 3 AI agent frameworks in 2026?";
const ta=pg.locator('textarea, input[type="text"]').last();
await ta.click().catch(()=>{});
for(let i=0;i<q.length;i+=3){await ta.fill(q.slice(0,i+3)).catch(()=>{}); if(i%9===0)await shot();}
await shot();await shot();
await pg.keyboard.press("Enter").catch(()=>{});
// capture "thinking" + the answer arriving
for(let i=0;i<18;i++){await pg.waitForTimeout(1500); await pg.evaluate(()=>window.scrollTo(0,document.body.scrollHeight)); await shot(); const done=await pg.evaluate(()=>/framework|LangGraph|1\./i.test(document.body.innerText)&&document.body.innerText.length>2500); if(done&&i>3)break;}
await pg.evaluate(()=>window.scrollTo(0,document.body.scrollHeight));
for(let i=0;i<4;i++){await shot();await pg.waitForTimeout(200);}
console.log("  chat:",f,"frames");
await b.close();
