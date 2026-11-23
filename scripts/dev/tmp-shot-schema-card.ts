// TEMPORARY — screenshot the new overview schema card against the real database,
// at desktop width and at the narrow width where the grid collapses.
import { chromium } from "playwright";
import { loadConfig } from "../../src/config";
import { buildServer } from "../../src/api/server";

async function main(): Promise<void> {
  const cfg = loadConfig();
  const app = await buildServer(cfg);
  await app.listen({ port: 3989, host: "127.0.0.1" });
  const BASE = "http://127.0.0.1:3989";

  const sid = "schemacardprobe0000000000000000";
  const [admins] = await app.pool.query("SELECT id, email FROM users WHERE role='admin' AND email_verified=1 ORDER BY id LIMIT 1");
  const admin = (admins as Array<{ id: number; email: string }>)[0];
  if (!admin) throw new Error("no verified admin");
  await app.pool.query(
    `INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, DATE_ADD(NOW(3), INTERVAL 10 MINUTE))
     ON DUPLICATE KEY UPDATE expires_at = VALUES(expires_at)`,
    [sid, admin.id],
  );
  console.log(`[shot] admin=${admin.email} id=${admin.id}`);

  const browser = await chromium.launch();
  try {
    for (const [label, width, height] of [
      ["admin-1440", 1440, 900],
      ["admin-1024", 1024, 800],
    ] as const) {
      const ctx = await browser.newContext({ viewport: { width, height } });
      await ctx.addCookies([{ name: "sid", value: sid, url: BASE }]);
      const page = await ctx.newPage();
      const res = await page.goto(`${BASE}/admin`, { waitUntil: "networkidle" });
      console.log(`[shot] ${label} -> ${res?.status()}`);
      // The card sits in the system-metrics row; scroll it to the top of the
      // viewport so the screenshot shows it without hunting.
      await page.evaluate(() => {
        document.querySelector(".stat-card--schema")?.scrollIntoView({ block: "center" });
      });
      await page.screenshot({ path: `D:/Temp/opencode/schema-card-${label}.png` });
      const card = await page.locator(".stat-card--schema").innerText().catch(() => "(missing)");
      console.log(`[shot] ${label} card text: ${card.replace(/\n/g, " | ")}`);
      await ctx.close();
    }
  } finally {
    await browser.close();
    await app.pool.query("DELETE FROM sessions WHERE id = ?", [sid]);
    await app.close();
    console.log("[shot] session removed, server closed");
  }
}

main().catch((e) => {
  console.error("[shot] FAILED:", e);
  process.exit(1);
});
