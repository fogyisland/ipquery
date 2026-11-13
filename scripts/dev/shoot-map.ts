// scripts/dev/shoot-map.ts — capture the /try result map.
//
// Reads the DB password from the environment so it never lands
// hardcoded in source:
//   SHOOT_DB_PASSWORD=secret npx tsx scripts/dev/shoot-map.ts
//
// Inserts a synthetic range with known coordinates, renders /try for
// it, and screenshots the result panel in both colour schemes.
//
// Outputs PNGs next to this file (gitignored).

import { chromium } from "playwright";
import * as path from "node:path";
import * as url from "node:url";
import * as mysql from "mysql2/promise";
import { loadConfig } from "../../src/config";

const here = path.dirname(url.fileURLToPath(import.meta.url));

const BASE = process.env.SHOOT_BASE_URL ?? "http://localhost:3880";
const PASSWORD = process.env.SHOOT_DB_PASSWORD;

if (!PASSWORD) {
  console.error("set SHOOT_DB_PASSWORD env var");
  process.exit(2);
}

// A synthetic range in the right-aligned 16-byte form parseIp() writes.
const START = "000000000000000000000000cb007100";
const END = "000000000000000000000000cb00717f";
const IP = "203.0.113.10";

async function seedRow(): Promise<void> {
  const cfg = loadConfig();
  // MAPSHOT_DB lets the caller point at the scratch database this
  // script's companion (prep-mapshot.ts) prepared, without touching
  // the project's own .env.
  const database = process.env.MAPSHOT_DB ?? cfg.db.database;
  const pool = await mysql.createPool({
    host: cfg.db.host,
    port: cfg.db.port,
    user: cfg.db.user,
    password: PASSWORD,
    database,
    timezone: "Z",
  });
  await pool.query(`DELETE FROM ip_ranges WHERE country_code = 'ZZ'`);
  await pool.query(
    `INSERT INTO ip_ranges
       (start_ip, end_ip, range_size, country_code, country_name, region, city,
        latitude, longitude, geo_source, country_source, city_source)
     VALUES (UNHEX(?), UNHEX(?), 255, 'ZZ', 'Testland', 'Test Region', 'Test City',
             35.6762, 139.6503, 'maxmind', 'maxmind', 'maxmind')`,
    [START, END],
  );
  await pool.end();
  console.log("seeded the synthetic range");
}

async function shoot(scheme: "light" | "dark"): Promise<void> {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width: 1000, height: 900 },
    colorScheme: scheme,
  });
  const page = await ctx.newPage();

  await page.goto(`${BASE}/try`);
  await page.fill('input[name="ip"]', IP);
  await Promise.all([page.waitForURL(/\/try/, { timeout: 15000 }), page.click('button[type="submit"]')]);
  await page.waitForSelector(".m-map-svg", { timeout: 10000 });
  await page.screenshot({ path: path.join(here, `screenshot-map-${scheme}.png`), fullPage: true });
  console.log(`saved screenshot-map-${scheme}.png`);

  const map = page.locator(".m-result-map");
  await map.screenshot({ path: path.join(here, `screenshot-map-panel-${scheme}.png`) });
  console.log(`saved screenshot-map-panel-${scheme}.png`);

  await browser.close();
}

async function main(): Promise<void> {
  await seedRow();
  await shoot("light");
  await shoot("dark");
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
