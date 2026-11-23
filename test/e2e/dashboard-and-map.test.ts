// SPDX-License-Identifier: MIT
//
// The dashboard and the world map, seen by a browser.
//
// Two pages, one file, because they share the setup: a fresh database,
// a running server and a real chromium.
//
// The dashboard's hero shows the user's most recent lookup. Before the
// metadata-lock fix, that hero read the query log with a LEFT JOIN
// against ip_ranges — so a pending RENAME TABLE parked the page for
// the server's year-long lock timeout and the browser showed an error
// instead of a dashboard. That is a regression waiting to happen, and
// the unit suite cannot catch it: `getLastUserQuery` returns a plain
// object either way.
//
// The map is server-rendered inline SVG. A unit test can read the
// string and check it contains "<svg", which is exactly the kind of
// assertion that passes while the browser shows a blank box.
//
// NOTE: this project has the `playwright` LIBRARY, not `@playwright/test`
// — so Playwright's `expect` extensions (`toBeVisible`, `toHaveText`)
// do not exist here. Every assertion below is a plain vitest `expect`
// over a value read out of the page.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  startE2e,
  stopE2e,
  withPage,
  createE2eUser,
  seedQueryLog,
  type E2eContext,
  type E2eUser,
} from "../helpers/e2e";
import { parseIp } from "../../src/ip";

let ctx: E2eContext;
let user: E2eUser;

beforeAll(async () => {
  ctx = await startE2e("dashboardmap");
  user = await createE2eUser(ctx, "dashboard-map@x.com", { displayName: "李四" });
}, 120_000);

afterAll(async () => {
  await stopE2e(ctx);
});

describe("the dashboard hero", () => {
  it("shows the user's last queried IP", async () => {
    // The hero is the page's signature element: the IP the user looked
    // up last, big and centred. If the query-log read regressed to a
    // JOIN against ip_ranges, this row would disappear — or the whole
    // page would time out behind a metadata lock.
    await seedQueryLog(ctx, user.id, "8.8.8.8", "hit");

    await withPage(ctx, user.sid, async (page) => {
      await page.goto(`${ctx.baseUrl}/dashboard`, { waitUntil: "domcontentloaded" });

      const hero = (await page.locator(".ip-hero").textContent())?.trim();
      expect(hero).toBe("8.8.8.8");
    });
  });

  it("shows the query's status", async () => {
    await seedQueryLog(ctx, user.id, "1.0.0.1", "miss");

    await withPage(ctx, user.sid, async (page) => {
      await page.goto(`${ctx.baseUrl}/dashboard`, { waitUntil: "domcontentloaded" });

      const meta = (await page.locator(".ip-hero-meta").textContent()) ?? "";
      expect(meta.length).toBeGreaterThan(0);
      // A miss must not be rendered as a hit.
      expect(await page.locator(".ip-status--miss").count()).toBe(1);
      expect(await page.locator(".ip-status--invalid").count()).toBe(0);
    });
  });

  it("loads without a server error", async () => {
    // The regression this file guards: the hero's query used to take a
    // metadata lock, and the page returned 500 while it waited.
    await withPage(ctx, user.sid, async (page) => {
      const response = await page.goto(`${ctx.baseUrl}/dashboard`, { waitUntil: "domcontentloaded" });
      expect(response?.status()).toBe(200);
    });
  });
});

describe("the dashboard sidebar", () => {
  it("shows the signed-in user's email", async () => {
    // The sidebar footer is where the session's email copy is
    // rendered. A stale session copy is the bug that made a renamed
    // account look like the save had failed.
    await withPage(ctx, user.sid, async (page) => {
      await page.goto(`${ctx.baseUrl}/dashboard`, { waitUntil: "domcontentloaded" });

      const shown = (await page.locator(".sidebar-user").textContent())?.trim();
      expect(shown).toBe("dashboard-map@x.com");
    });
  });

  it("offers a link to the profile", async () => {
    await withPage(ctx, user.sid, async (page) => {
      await page.goto(`${ctx.baseUrl}/dashboard`, { waitUntil: "domcontentloaded" });

      const hrefs = await page
        .locator(".sidebar a")
        .evaluateAll((els) => els.map((el) => (el as HTMLAnchorElement).getAttribute("href")));
      expect(hrefs.some((h) => h?.startsWith("/dashboard/profile"))).toBe(true);
    });
  });
});

describe("the world map on /try", () => {
  /**
   * Put one range into ip_ranges so a lookup has something to find.
   *
   * `parseIp` already returns the 16-byte BINARY(16) form with the
   * address left-aligned in the last four bytes — the encoding the
   * migration 012/023 pair settled on. Re-encoding it here would store
   * an address no lookup could match, which is a bug this project
   * already paid for once.
   *
   * The insert is idempotent: the table has a UNIQUE key on
   * (start_ip, end_ip), and three tests in this file seed the same
   * address.
   */
  async function seedRange(ipText: string, lat: number, lon: number): Promise<void> {
    const buf = parseIp(ipText);
    if (!buf) throw new Error(`not an IP: ${ipText}`);

    await ctx.app.pool.query(
      `INSERT INTO ip_ranges
         (start_ip, end_ip, range_size, country_code, country_name, city,
          latitude, longitude, country_source, city_source, geo_source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         latitude = VALUES(latitude),
         longitude = VALUES(longitude)`,
      [buf, buf, 1, "US", "United States", "Mountain View", lat, lon, "dbip", "dbip", "dbip"],
    );
  }

  /**
   * Look an IP up the way a visitor does: type it, submit the form.
   *
   * `/try` is a POST endpoint behind a CSRF token, not a GET with a
   * query parameter. Driving it through the form is also the honest
   * test — it exercises the CSRF token, the token check and the
   * redirect-free re-render in one go.
   *
   * The page answers in one of three shapes: a result panel
   * (`.m-result-panel`), a "not found" alert, or an "invalid" alert.
   * Waiting for any of the three is the signal that the round trip
   * finished.
   */
  async function lookUp(page: import("playwright").Page, ipText: string): Promise<void> {
    await page.goto(`${ctx.baseUrl}/try`, { waitUntil: "domcontentloaded" });
    await page.locator('input[name="ip"]').fill(ipText);
    await page.locator('.m-try-form button[type="submit"]').click();
    await page.waitForSelector("#try-result .m-result-panel, #try-result .m-alert", { timeout: 15_000 });
  }

  it("renders the map as inline SVG with a marker", async () => {
    await seedRange("9.9.9.9", 37.4056, -122.0775);

    await withPage(ctx, undefined, async (page) => {
      await lookUp(page, "9.9.9.9");

      const svgCount = await page.locator("svg.m-map-svg").count();
      expect(svgCount).toBe(1);

      // The marker is a <g> holding two circles — the halo and the dot.
      const markerCircles = await page.locator("svg.m-map-svg .m-map-marker circle").count();
      expect(markerCircles).toBe(2);

      // The land path is what makes it a map rather than a blank box.
      const land = await page.locator("svg.m-map-svg path.m-map-land").getAttribute("d");
      expect((land ?? "").length).toBeGreaterThan(100);
    });
  });

  it("gives the map an accessible label", async () => {
    // The SVG is an image to a screen reader, so it needs a label that
    // says what it is. `role="img"` without `aria-label` is a silent
    // decorative blob.
    await seedRange("9.9.9.9", 37.4056, -122.0775);

    await withPage(ctx, undefined, async (page) => {
      await lookUp(page, "9.9.9.9");

      const role = await page.locator("svg.m-map-svg").getAttribute("role");
      const label = await page.locator("svg.m-map-svg").getAttribute("aria-label");
      expect(role).toBe("img");
      expect((label ?? "").length).toBeGreaterThan(0);
      expect(label).toContain("9.9.9.9");
    });
  });

  it("places the marker where the coordinates project to", async () => {
    // A marker parked at a fixed spot would still pass a "is there a
    // marker somewhere on the map" check. This one computes the
    // expected position from the projection the server uses and
    // compares — the projection is two arithmetic steps, so the
    // expected value is exact.
    await seedRange("9.9.9.9", 37.4056, -122.0775);

    await withPage(ctx, undefined, async (page) => {
      await lookUp(page, "9.9.9.9");

      const cx = await page.locator("svg.m-map-svg .m-map-marker circle").first().getAttribute("cx");
      const cy = await page.locator("svg.m-map-svg .m-map-marker circle").first().getAttribute("cy");

      // x = (lon + 180) / 360 * W, y = (90 - lat) / 180 * H
      const expectedX = ((-122.0775 + 180) / 360) * 720;
      const expectedY = ((90 - 37.4056) / 180) * 360;

      expect(Number(cx)).toBeCloseTo(expectedX, 1);
      expect(Number(cy)).toBeCloseTo(expectedY, 1);
    });
  });

  it("shows a not-found notice rather than an empty map", async () => {
    // An IP with no range has no coordinates, so there is no map. The
    // page has to say that outright — an empty map frame would tell
    // the visitor "we know where this is" when we do not.
    await withPage(ctx, undefined, async (page) => {
      await lookUp(page, "192.0.2.222");

      expect(await page.locator("svg.m-map-svg").count()).toBe(0);
      // The result panel never renders at all for a miss, and the
      // page says so in a warning.
      expect(await page.locator(".m-result-panel").count()).toBe(0);
      const alerts = await page.locator("#try-result .m-alert--warn").count();
      expect(alerts).toBe(1);
    });
  });
});
