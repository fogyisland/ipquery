// SPDX-License-Identifier: MIT
// Screenshot one URL at a given width as a signed-in admin.
const { chromium } = require("playwright");
const path = require("path");
const BASE = "http://127.0.0.1:5051";
const OUT = "E:/ToolDevelop/IPQuery/shots";
const [urlPath, w, h, name] = process.argv.slice(2);
(async () => {
  const b = await chromium.launch();
  const ctl = await b.newPage({ viewport: { width: 1440, height: 900 } });
  await ctl.goto(BASE + "/login", { waitUntil: "networkidle" });
  await ctl.fill('[name="email"]', process.env.SHOOT_EMAIL || "");
  await ctl.fill('[name="password"]', process.env.SHOOT_PASSWORD || "");
  await Promise.all([ctl.waitForNavigation({ waitUntil: "networkidle" }), ctl.click('button[type="submit"]')]);
  const cookies = await ctl.context().cookies();
  const ctx = await b.newContext({ viewport: { width: Number(w), height: Number(h) } });
  await ctx.addCookies(cookies);
  const p = await ctx.newPage();
  await p.goto(BASE + urlPath, { waitUntil: "networkidle" });
  await p.screenshot({ path: path.join(OUT, name + ".png"), fullPage: true });
  console.log("saved", name);
  await b.close();
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
