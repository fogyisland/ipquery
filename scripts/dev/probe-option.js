// SPDX-License-Identifier: MIT
const { chromium } = require("playwright");
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  await p.goto("http://127.0.0.1:5051/init/seed", { waitUntil: "networkidle" });
  const info = await p.evaluate(() => {
    const label = document.querySelector(".boot-option-label");
    const title = document.querySelector(".boot-option-title");
    const hint = document.querySelector(".boot-option-hint");
    const g = (el) => {
      if (!el) return null;
      const cs = getComputedStyle(el);
      return { width: cs.width, display: cs.display, gridCol: cs.gridColumnStart,
               gridColEnd: cs.gridColumnEnd, font: cs.fontSize, lineH: cs.lineHeight };
    };
    const lg = getComputedStyle(label).gridTemplateColumns;
    return {
      labelGrid: lg,
      labelWidth: getComputedStyle(label).width,
      label: g(label), title: g(title), hint: g(hint),
      children: [...label.children].map((c) => ({
        cls: c.className, width: getComputedStyle(c).width,
        cols: getComputedStyle(c).gridColumn,
      })),
    };
  });
  console.log(JSON.stringify(info, null, 2));
  await b.close();
})().catch((e) => { console.error(e.message); process.exit(1); });
