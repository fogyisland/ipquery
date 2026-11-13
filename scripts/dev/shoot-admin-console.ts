// scripts/dev/shoot-admin-console.ts — capture the admin console pages.
// Run after the server is up (npx tsx src/cli.ts serve).
//
//   SHOOT_BASE_URL=http://localhost:3899 \
//   SHOOT_EMAIL=... SHOOT_PASSWORD=... \
//   node --import tsx scripts/dev/shoot-admin-console.ts
//
// Outputs PNGs next to this file (gitignored).

import { chromium } from "playwright";
import * as path from "node:path";
import * as url from "node:url";

const here = path.dirname(url.fileURLToPath(import.meta.url));

const BASE = process.env.SHOOT_BASE_URL ?? "http://localhost:3899";
const EMAIL = process.env.SHOOT_EMAIL;
const PASSWORD = process.env.SHOOT_PASSWORD;

if (!EMAIL || !PASSWORD) {
  console.error("set SHOOT_EMAIL and SHOOT_PASSWORD env vars");
  process.exit(2);
}

interface Shot {
  path: string;
  url: string;
  /** A clip on the element, rather than the whole page. */
  selector?: string;
  fullPage?: boolean;
}

async function main(): Promise<void> {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();

  await page.goto(`${BASE}/login`);
  await page.fill('input[name="email"]', EMAIL);
  await page.fill('input[name="password"]', PASSWORD);
  await Promise.all([
    page.waitForURL(/\/dashboard|\/admin/, { timeout: 15000 }),
    page.click('button[type="submit"]'),
  ]);

  const shots: Shot[] = [
    { path: "shot-admin-dashboard.png", url: "/admin", fullPage: true },
    { path: "shot-admin-queries.png", url: "/admin/queries", fullPage: true },
    { path: "shot-admin-users.png", url: "/admin/users", fullPage: true },
    { path: "shot-admin-etl.png", url: "/admin/etl/runs", fullPage: true },
    { path: "shot-admin-keys.png", url: "/admin/keys", fullPage: true },
    { path: "shot-sidebar.png", url: "/admin", selector: ".sidebar" },
    // The sidebar on a DETAIL page: the section entry must stay lit.
    { path: "shot-sidebar-user-detail.png", url: "/admin/users/1", selector: ".sidebar" },
    // Narrow viewport: the sidebar stacks and the tables scroll sideways.
    { path: "shot-admin-users-narrow.png", url: "/admin/users", fullPage: true },
  ];

  for (const shot of shots) {
    const viewport = shot.path.includes("narrow")
      ? { width: 390, height: 844 }
      : { width: 1440, height: 900 };
    await page.setViewportSize(viewport);
    await page.goto(`${BASE}${shot.url}`, { waitUntil: "networkidle" });
    const target = shot.selector ? page.locator(shot.selector) : page;
    await target.screenshot({
      path: path.join(here, shot.path),
      fullPage: shot.selector ? undefined : (shot.fullPage ?? false),
    });
    console.log("saved", shot.path);
  }

  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
