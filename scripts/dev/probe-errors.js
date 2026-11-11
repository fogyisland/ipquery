// SPDX-License-Identifier: MIT
// Verify the error surfaces after the errors.css split and the /admin 404
// guard: (1) a signed-in non-admin gets the HTML 404 page from errors/404.hbs,
// (2) the sidebar logout button is a link, not a cyan full-width banner.
const { chromium } = require("playwright");
const path = require("path");
const OUT = path.resolve(__dirname, "../../shots");
const BASE = "http://127.0.0.1:5051";

async function login(page, email, password) {
  await page.goto(BASE + "/login", { waitUntil: "networkidle" });
  await page.fill('[name="email"]', email);
  await page.fill('[name="password"]', password);
  await Promise.all([page.waitForNavigation({ waitUntil: "networkidle" }), page.click('button[type="submit"]')]);
}

async function snapshot(page, label, url) {
  const resp = await page.goto(BASE + url, { waitUntil: "networkidle" });
  const info = await page.evaluate((base) => {
    const cs = (sel, props) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const s = getComputedStyle(el);
      return Object.fromEntries(props.map((p) => [p, s.getPropertyValue(p)]));
    };
    const h1 = document.querySelector(".boot-step-head h1");
    return {
      h1Text: h1 ? h1.textContent.trim() : null,
      h1: cs(".boot-step-head h1", ["font-size", "font-weight", "color"]),
      lede: cs(".boot-lede", ["font-size", "color"]),
      btn: cs(".btn-primary", ["background-color", "color", "border-radius", "min-height"]),
      logout: cs(".sidebar-logout", ["background-color", "color", "font-size", "border-radius"]),
      sheets: [...document.styleSheets].map((s) => (s.href || "(inline)").replace(base, "")),
      overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  }, BASE);
  await page.screenshot({ path: path.join(OUT, `error-${label}.png`), fullPage: true });
  console.log(`\n=== ${label} ${url} (HTTP ${resp.status()}) ===`);
  console.log(JSON.stringify(info, null, 2));
  return resp.status();
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  // Credentials of a scratch test user created only for this probe;
// adjust to your local test instance before running.
await login(page, process.env.SHOOT_EMAIL || "plain-user@example.com", process.env.SHOOT_PASSWORD || "PlainUserPass123");
  console.log("登录后:", page.url());

  const notFoundStatus = await snapshot(page, "admin-404", "/admin");
  await snapshot(page, "admin-deep-404", "/admin/users/99999");

  // 横向溢出检查：移动端
  await page.setViewportSize({ width: 390, height: 844 });
  await snapshot(page, "admin-404-mobile", "/admin");

  console.log("\n/admin 对非管理员返回:", notFoundStatus, notFoundStatus === 404 ? "✓" : "✗ 期望 404");
  await browser.close();
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
