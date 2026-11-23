// SPDX-License-Identifier: MIT
// Screenshot the marketing top nav's account menu, open and closed.
//
// The menu is a <details> element, so "opening" it is a click on the
// <summary> — no JS injection needed.
//
// The PNGs land next to this script, where .gitignore already covers
// them (scripts/dev/*.png).
const { chromium } = require("playwright");
const path = require("path");
const BASE = process.env.SHOOT_BASE || "http://127.0.0.1:3880";
const SID = process.env.SHOOT_SID || "";
const OUT = __dirname;

(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addCookies([
    { name: "sid", value: SID, domain: "127.0.0.1", path: "/" },
  ]);
  const p = await ctx.newPage();

  await p.goto(BASE + "/", { waitUntil: "networkidle" });
  await p.screenshot({ path: path.join(OUT, "account-menu-closed.png") });
  console.log("saved account-menu-closed");

  // Open the menu.
  await p.click(".m-account-trigger");
  await p.waitForTimeout(300);
  await p.screenshot({ path: path.join(OUT, "account-menu-open.png") });
  console.log("saved account-menu-open");

  // The profile overview.
  await p.goto(BASE + "/dashboard/profile", { waitUntil: "networkidle" });
  await p.screenshot({ path: path.join(OUT, "profile-overview.png"), fullPage: true });
  console.log("saved profile-overview");

  // The details sub-page.
  await p.goto(BASE + "/dashboard/profile/details", { waitUntil: "networkidle" });
  await p.screenshot({ path: path.join(OUT, "profile-details.png"), fullPage: true });
  console.log("saved profile-details");

  // The password sub-page.
  await p.goto(BASE + "/dashboard/profile/password", { waitUntil: "networkidle" });
  await p.screenshot({ path: path.join(OUT, "profile-password.png"), fullPage: true });
  console.log("saved profile-password");

  await b.close();
})().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});
