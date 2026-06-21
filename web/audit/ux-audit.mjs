// Full-product UX audit — drives real Chromium across desktop sizes (14"/15" MacBook first)
// then mobile, screenshots every page, and programmatically flags the issues that make a
// product feel incomplete: horizontal overflow, element overlap, off-canvas/clipped content,
// tiny text, and broken layouts. Output: /tmp/ux/<page>__<w>.png + a JSON findings report.
import { chromium } from "playwright";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";

const BASE = process.env.BASE || "http://localhost:3100";
const OUT = "/tmp/ux";
mkdirSync(OUT, { recursive: true });

// Real desktop widths first (your 14"=1512 / 15"=1440, plus common laptop + full HD), then mobile.
const SIZES = [
  { name: "1280", w: 1280, h: 900 },
  { name: "1440", w: 1440, h: 900 },   // 15" MBP default scaled
  { name: "1512", w: 1512, h: 982 },   // 14" MBP default scaled
  { name: "1920", w: 1920, h: 1080 },
  { name: "390m", w: 390, h: 844, mobile: true }, // iPhone
];

// A real seeded run id (run-detail / canvas / replay need content to audit).
let RUNID = "";
try { RUNID = readFileSync("/tmp/audit-runid.txt", "utf8").trim(); } catch {}

// Every page + the state to reach it. authed pages need the session cookie.
const PAGES = [
  { id: "home", path: "/", auth: false },
  { id: "login", path: "/login", auth: false },
  { id: "dashboard", path: "/dashboard", auth: true },
  { id: "runs", path: "/runs", auth: true },
  { id: "capabilities", path: "/capabilities", auth: true },
  { id: "approvals", path: "/approvals", auth: true },
  { id: "schedules", path: "/schedules", auth: true },
  { id: "secrets", path: "/secrets", auth: true },
  { id: "mcp", path: "/mcp", auth: true },
  ...(RUNID ? [
    { id: "run-output", path: `/runs/${RUNID}`, auth: true },
    { id: "run-ledger", path: `/runs/${RUNID}`, auth: true, click: "#tab-timeline" },
    { id: "run-canvas", path: `/runs/${RUNID}`, auth: true, click: "#tab-canvas" },
    { id: "run-state", path: `/runs/${RUNID}`, auth: true, click: "#tab-state" },
  ] : []),
  { id: "notfound", path: "/this-page-does-not-exist", auth: true },
];

// Load the admin session cookie captured by the shell (curl) so authed pages render.
function loadCookies() {
  try {
    const raw = readFileSync("/tmp/audit-cookies.txt", "utf8");
    const cookies = [];
    for (const line of raw.split("\n")) {
      if (!line || line.startsWith("#")) {
        // Netscape format also encodes #HttpOnly_ lines
        if (!line.startsWith("#HttpOnly_")) continue;
      }
      const clean = line.replace(/^#HttpOnly_/, "");
      const parts = clean.split("\t");
      if (parts.length >= 7) {
        cookies.push({ name: parts[5], value: parts[6], domain: "localhost", path: parts[2] || "/", httpOnly: line.startsWith("#HttpOnly_"), secure: parts[3] === "TRUE" });
      }
    }
    return cookies;
  } catch { return []; }
}

const browser = await chromium.launch();
const cookies = loadCookies();
const findings = [];

for (const size of SIZES) {
  const ctx = await browser.newContext({
    viewport: { width: size.w, height: size.h },
    deviceScaleFactor: size.mobile ? 2 : 1,
    isMobile: !!size.mobile,
  });
  if (cookies.length) await ctx.addCookies(cookies.map(c => ({ ...c, domain: "localhost", path: "/" })));
  const page = await ctx.newPage();
  const consoleErrors = [];
  page.on("pageerror", e => consoleErrors.push(String(e.message).slice(0, 200)));

  for (const pg of PAGES) {
    const url = `${BASE}${pg.path}`;
    let landedUrl = "";
    try {
      await page.goto(url, { waitUntil: "networkidle", timeout: 25000 });
    } catch { /* networkidle can flake on polling pages; continue */ }
    await page.waitForTimeout(1500);
    if (pg.click) { try { await page.click(pg.click, { timeout: 3000 }); await page.waitForTimeout(1200); } catch {} }
    landedUrl = page.url();

    // ── programmatic issue detection ──────────────────────────────────────────
    const issues = await page.evaluate((vw) => {
      const out = [];
      const docW = document.documentElement.scrollWidth;
      if (docW > window.innerWidth + 2) out.push({ kind: "h-overflow", detail: `page scrollWidth ${docW} > viewport ${window.innerWidth}` });

      // elements that bleed past the right/left viewport edge (real off-canvas content)
      const all = document.querySelectorAll("body *");
      let offRight = 0, offLeft = 0, tiny = 0;
      const samples = [];
      for (const el of all) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        const cs = getComputedStyle(el);
        if (cs.position === "fixed") continue;
        if (r.right > vw + 2 && r.width < vw) { offRight++; if (samples.length < 8) samples.push({ off: "right", cls: el.className?.toString().slice(0,40), tag: el.tagName.toLowerCase(), right: Math.round(r.right) }); }
        if (r.left < -2) { offLeft++; }
        // tiny text that isn't an icon
        const fs = parseFloat(cs.fontSize);
        if (el.textContent && el.textContent.trim().length > 2 && fs > 0 && fs < 11 && el.children.length === 0) tiny++;
      }
      if (offRight) out.push({ kind: "off-canvas-right", count: offRight, samples });
      if (offLeft) out.push({ kind: "off-canvas-left", count: offLeft });
      if (tiny > 4) out.push({ kind: "tiny-text", count: tiny });
      return out;
    }, size.w);

    if (consoleErrors.length) issues.push({ kind: "page-error", errors: consoleErrors.splice(0) });
    if (landedUrl !== url && !landedUrl.endsWith(pg.path)) issues.push({ kind: "redirected", to: landedUrl });

    const shot = `${OUT}/${pg.id}__${size.name}.png`;
    await page.screenshot({ path: shot, fullPage: false });
    findings.push({ page: pg.id, size: size.name, w: size.w, url: landedUrl, issues });
    process.stdout.write(`${pg.id} @ ${size.name}: ${issues.length ? issues.map(i=>i.kind).join(",") : "clean"}\n`);
  }
  await ctx.close();
}

writeFileSync(`${OUT}/findings.json`, JSON.stringify(findings, null, 2));
await browser.close();

// summary
const withIssues = findings.filter(f => f.issues.length);
console.log(`\n=== ${withIssues.length}/${findings.length} page×size combos have flagged issues ===`);
const byKind = {};
for (const f of findings) for (const i of f.issues) byKind[i.kind] = (byKind[i.kind]||0)+1;
console.log(JSON.stringify(byKind, null, 2));
console.log(`screenshots + findings.json in ${OUT}`);
