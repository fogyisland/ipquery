// SPDX-License-Identifier: MIT
// Screenshot one URL at a given width as a signed-in admin.
//
// Two ways in:
//   SHOOT_COOKIE="sid=…"  — reuse a session that already exists. Preferred:
//                            it needs no password on the command line, and it
//                            works for accounts whose password nobody kept.
//   SHOOT_EMAIL / SHOOT_PASSWORD — log in through the form instead.
//
// The base URL is SHOOT_BASE, defaulting to the dev port.
const { chromium } = require("playwright");
const path = require("path");
const BASE = process.env.SHOOT_BASE || "http://127.0.0.1:3880";
const OUT = "E:/ToolDevelop/IPQuery/shots";
const [urlPath, w, h, name] = process.argv.slice(2);
(async () => {
  const b = await chromium.launch();
  const ctl = await b.newPage({ viewport: { width: 1440, height: 900 } });
  let cookies = [];
  if (process.env.SHOOT_COOKIE) {
    const [key, value] = process.env.SHOOT_COOKIE.split("=");
    cookies = [{ name: key, value, domain: "127.0.0.1", path: "/" }];
  } else {
    await ctl.goto(BASE + "/login", { waitUntil: "networkidle" });
    await ctl.fill('[name="email"]', process.env.SHOOT_EMAIL || "");
    await ctl.fill('[name="password"]', process.env.SHOOT_PASSWORD || "");
    await Promise.all([ctl.waitForNavigation({ waitUntil: "networkidle" }), ctl.click('button[type="submit"]')]);
    cookies = await ctl.context().cookies();
  }
  const ctx = await b.newContext({ viewport: { width: Number(w), height: Number(h) } });
  await ctx.addCookies(cookies);
  const p = await ctx.newPage();
  await p.goto(BASE + urlPath, { waitUntil: "networkidle" });
  await p.screenshot({ path: path.join(OUT, name + ".png"), fullPage: true });
  console.log("saved", name);
  await b.close();
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
