// SPDX-License-Identifier: MIT
// Visual probe for the redesigned setup wizard. Screenshots every step at
// desktop and mobile widths and dumps computed styles so a regression in the
// design tokens shows up as a number, not an opinion.
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const BASE = "http://127.0.0.1:5051";
const OUT = path.resolve(__dirname, "../../shots");

const STEPS = [
  ["01-welcome", "/init"],
  ["02-database", "/init/database"],
  ["03-site", "/init/site"],
  ["04-admin", "/init/admin"],
  ["05-seed", "/init/seed"],
  ["06-complete", "/init/complete"],
];

const VIEWPORTS = [
  ["desktop", { width: 1440, height: 900 }],
  ["mobile", { width: 390, height: 844 }],
];

async function probe(page, label) {
  return page.evaluate((stepLabel) => {
    const pick = (sel) => document.querySelector(sel);
    const css = (el, props) => {
      if (!el) return null;
      const cs = getComputedStyle(el);
      const out = {};
      for (const p of props) out[p] = cs.getPropertyValue(p);
      return out;
    };
    const rail = pick(".boot-rail");
    const frame = pick(".boot-frame");
    const h1 = pick(".boot-step-head h1");
    const lede = pick(".boot-lede");
    const btn = pick(".btn-primary") || pick('button[type="submit"]');
    const step = pick(".setup-step.is-active a");
    return {
      step: stepLabel,
      title: document.title,
      cssLoaded: [...document.styleSheets].length,
      bodyBg: css(document.body, ["background-color"]),
      bodyFont: css(document.body, ["font-family", "font-size"]),
      railBg: css(rail, ["background-image", "border-right-width"]),
      frame: css(frame, ["background-color", "border-radius", "max-width"]),
      h1: css(h1, ["font-size", "font-weight", "color"]),
      lede: css(lede, ["font-size", "color"]),
      btn: css(btn, ["background-color", "color", "border-radius", "min-height", "font-weight"]),
      activeStep: css(step, ["background-color", "color"]),
      overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      h1Text: h1 ? h1.textContent.trim() : null,
    };
  }, label);
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  const report = [];

  for (const [vpName, viewport] of VIEWPORTS) {
    const page = await browser.newPage({ viewport });
    const consoleErrors = [];
    page.on("console", (m) => {
      if (m.type() === "error") consoleErrors.push(m.text());
    });

    for (const [label, url] of STEPS) {
      const resp = await page.goto(BASE + url, { waitUntil: "networkidle" });
      const file = path.join(OUT, `${vpName}-${label}.png`);
      await page.screenshot({ path: file, fullPage: true });
      const data = await probe(page, label);
      data.viewport = vpName;
      data.status = resp ? resp.status() : "no-response";
      report.push(data);
    }
    if (consoleErrors.length > 0) {
      report.push({ viewport: vpName, consoleErrors });
    }
    await page.close();
  }

  await browser.close();
  console.log(JSON.stringify(report, null, 2));
})().catch((err) => {
  console.error("PROBE FAILED:", err.message);
  process.exit(1);
});
