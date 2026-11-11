// SPDX-License-Identifier: MIT
const { chromium } = require("playwright");
const path = require("path");
const BASE = "http://127.0.0.1:5051";
(async () => {
  const b = await chromium.launch();
  const ctl = await b.newPage({ viewport: { width: 1440, height: 900 } });
  await ctl.goto(BASE + "/login", { waitUntil: "networkidle" });
  await ctl.fill('[name="email"]', process.env.SHOOT_EMAIL || "");
  await ctl.fill('[name="password"]', process.env.SHOOT_PASSWORD || "");
  await Promise.all([ctl.waitForNavigation({ waitUntil: "networkidle" }), ctl.click('button[type="submit"]')]);
  const cookies = await ctl.context().cookies();
  await ctl.close();
  for (const [w, h, name] of [[1440, 900, "desktop"], [390, 844, "mobile"]]) {
    const ctx = await b.newContext({ viewport: { width: w, height: h } });
    await ctx.addCookies(cookies);
    const p = await ctx.newPage();
    await p.goto(BASE + "/admin/users", { waitUntil: "networkidle" });
    await p.screenshot({ path: path.join("E:/ToolDevelop/IPQuery/shots", `table-${name}.png`), fullPage: false });
    const info = await p.evaluate(() => {
      const t = document.querySelector("table.table");
      const cs = getComputedStyle(t);
      return { tableW: Math.round(t.getBoundingClientRect().width), scrollW: t.scrollWidth, clientW: t.clientWidth, display: cs.display };
    });
    console.log(name, JSON.stringify(info));
    await ctx.close();
  }
  await b.close();
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
