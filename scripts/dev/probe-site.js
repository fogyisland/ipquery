// SPDX-License-Identifier: MIT
// Site-wide layout regression after the global `box-sizing: border-box` reset.
// Every page a signed-in admin can reach, at desktop and mobile, checking for
// horizontal overflow and console errors.
const { chromium } = require("playwright");
const path = require("path");
const OUT = path.resolve(__dirname, "../../shots/site");
const BASE = "http://127.0.0.1:5051";

const PAGES = [
  "/", "/try", "/docs", "/about",
  "/dashboard", "/dashboard/history", "/dashboard/keys", "/dashboard/profile",
  "/admin", "/admin/users", "/admin/etl/runs", "/admin/queries", "/admin/keys",
  "/admin/audit", "/admin/ingest", "/admin/providers", "/admin/audit-log", "/admin/settings",
  "/login", "/signup",
];

const VIEWPORTS = [
  ["desktop", { width: 1440, height: 900 }],
  ["mobile", { width: 390, height: 844 }],
];

(async () => {
  require("fs").mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  const ctl = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await ctl.goto(BASE + "/login", { waitUntil: "networkidle" });
  await ctl.fill('[name="email"]', process.env.SHOOT_EMAIL || "");
  await ctl.fill('[name="password"]', process.env.SHOOT_PASSWORD || "");
  await Promise.all([ctl.waitForNavigation({ waitUntil: "networkidle" }), ctl.click('button[type="submit"]')]);
  const cookies = await ctl.context().cookies();
  await ctl.close();

  const bad = [];
  for (const [vpName, viewport] of VIEWPORTS) {
    const ctx = await browser.newContext({ viewport });
    await ctx.addCookies(cookies);
    const page = await ctx.newPage();
    const errs = [];
    page.on("console", (m) => { if (m.type() === "error") errs.push(m.text()); });

    for (const url of PAGES) {
      errs.length = 0;
      const resp = await page.goto(BASE + url, { waitUntil: "networkidle" });
      const overflowX = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      const slug = url.replace(/\//g, "_") || "_root";
      await page.screenshot({ path: path.join(OUT, `${vpName}${slug}.png`), fullPage: true });
      const line = { viewport: vpName, url, status: resp ? resp.status() : 0, overflowX, consoleErrors: errs.length };
      if (overflowX > 0 || errs.length > 0 || !resp || resp.status() >= 500) bad.push(line);
      process.stdout.write(`${vpName.padEnd(7)} ${String(line.status).padEnd(4)} overflow=${String(overflowX).padEnd(4)} err=${errs.length}  ${url}\n`);
    }
    await ctx.close();
  }
  await browser.close();
  console.log(`\n问题页数: ${bad.length}`);
  if (bad.length) console.log(JSON.stringify(bad, null, 2));
})().catch((e) => { console.error("PROBE FAILED:", e.message); process.exit(1); });
