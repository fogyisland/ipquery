// scripts/dev/shoot-ingest.ts — capture the ingest console (renamed from
// /admin/unknown-ips on 2026-09-08 in commit ba5f684).
//
// Reads creds from env:
//   SHOOT_EMAIL=you@example.com SHOOT_PASSWORD=secret node --import tsx scripts/dev/shoot-ingest.ts

import { chromium } from "playwright";
import * as path from "node:path";
import * as url from "node:url";

const here = path.dirname(url.fileURLToPath(import.meta.url));

const BASE = process.env.SHOOT_BASE_URL ?? "http://localhost:5001";
const EMAIL = process.env.SHOOT_EMAIL;
const PASSWORD = process.env.SHOOT_PASSWORD;

if (!EMAIL || !PASSWORD) {
  console.error("set SHOOT_EMAIL and SHOOT_PASSWORD env vars");
  process.exit(2);
}

async function main(): Promise<void> {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();

  await page.goto(`${BASE}/login`);
  await page.fill('input[name="email"]', EMAIL);
  await page.fill('input[name="password"]', PASSWORD);
  await Promise.all([
    page.waitForURL(/\/dashboard|\/admin/, { timeout: 10000 }),
    page.click('button[type="submit"]'),
  ]);

  await page.goto(`${BASE}/admin/ingest`, { waitUntil: "networkidle" });
  await page.screenshot({ path: path.join(here, "screenshot-ingest.png"), fullPage: true });
  console.log("saved screenshot-ingest.png");

  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
