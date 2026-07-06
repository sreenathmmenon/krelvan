import { chromium } from "playwright-core";
const WEB="http://localhost:3105", SHOTS="/Users/sreenath/Code/myAIExps/krelvan-private/screenshots";
const b=await chromium.launch({executablePath:"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",headless:true});
const pg=await (await b.newContext({viewport:{width:1440,height:1000},deviceScaleFactor:2})).newPage();
await pg.goto(`${WEB}/login`,{waitUntil:"domcontentloaded",timeout:10000}).catch(()=>{}); await pg.waitForTimeout(3000);
await pg.locator('input:not([type="password"]):visible').first().fill("sreenath").catch(()=>{});
await pg.locator('input[type="password"]:visible').first().fill("Krelvan-live-2026!").catch(()=>{});
await pg.getByRole("button",{name:/sign in/i}).click().catch(()=>{}); await pg.waitForTimeout(4000);
// find the assistant agent
const id=await pg.evaluate(async()=>{const j=await (await fetch("/proxy/api/agents")).json();const a=(j.agents||j).find(x=>x.name&&x.name.includes("Assistant"));return a?.id;});
await pg.goto(`${WEB}/agents/${id}`,{waitUntil:"domcontentloaded",timeout:12000}).catch(()=>{}); await pg.waitForTimeout(2500);
await pg.evaluate(()=>{const t=[...document.querySelectorAll('[role="tab"],button')].find(e=>/^chat$/i.test((e.textContent||"").trim()));t&&t.click();});
await pg.waitForTimeout(1500);
// scroll the chat panel into view + find the composer input precisely
await pg.evaluate(()=>window.scrollTo(0,document.body.scrollHeight));
await pg.waitForTimeout(500);
const input=pg.locator('input[type="text"], textarea').last();
await input.scrollIntoViewIfNeeded().catch(()=>{});
await input.click().catch(()=>{});
await input.type("What are the top 3 mistakes teams make adopting AI agents? Keep it tight.",{delay:10}).catch(()=>{});
await pg.keyboard.press("Enter").catch(()=>{});
// wait for the reply to render (poll for an agent bubble)
for(let i=0;i<20;i++){await pg.waitForTimeout(2000); const has=await pg.evaluate(()=>document.body.innerText.includes("Autopilot")||document.body.innerText.match(/1\.|mistake|review/i)); if(has)break;}
await pg.waitForTimeout(2000);
// follow-up
await input.click().catch(()=>{});
await input.type("Give me a punchy LinkedIn hook for the first one.",{delay:10}).catch(()=>{});
await pg.keyboard.press("Enter").catch(()=>{});
for(let i=0;i<20;i++){await pg.waitForTimeout(2000); const n=await pg.evaluate(()=>document.querySelectorAll('[class*="ab"],[role="log"] > *').length); if(n>=3)break;}
await pg.waitForTimeout(2000);
await pg.evaluate(()=>window.scrollTo(0,document.body.scrollHeight));
await pg.screenshot({path:`${SHOTS}/feature-chat.png`,fullPage:true});
console.log("chat conversation screenshot saved");
await b.close();
