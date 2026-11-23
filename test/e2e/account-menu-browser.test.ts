// SPDX-License-Identifier: MIT
//
// The account menu, clicked.
//
// The menu in the top right is a `<details>` element. That choice was
// deliberate — CSP `script-src 'self'` forbids an inline handler, and
// `<details>` gives open/close, Escape and keyboard operation for
// free — but it also means the menu's whole behaviour is the
// BROWSER's, not the server's.
//
// The server-side tests can only check that the markup is in the page.
// They cannot check that clicking the summary opens it, that the menu
// closes again, that the four items are reachable, or that the logout
// button actually ends the session.
//
// This test does all of that in a real browser.
//
// NOTE: this project has the `playwright` LIBRARY, not `@playwright/test`
// — so Playwright's `expect` extensions (`toBeVisible`, `toHaveText`)
// do not exist here. Every assertion below is a plain vitest `expect`
// over a value read out of the page.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startE2e, stopE2e, withPage, createE2eUser, type E2eContext, type E2eUser } from "../helpers/e2e";

let ctx: E2eContext;
let user: E2eUser;

beforeAll(async () => {
  ctx = await startE2e("accountmenu");
  user = await createE2eUser(ctx, "account-menu@x.com", { displayName: "张三" });
}, 120_000);

afterAll(async () => {
  await stopE2e(ctx);
});

describe("the account menu", () => {
  it("is closed when the page loads", async () => {
    await withPage(ctx, user.sid, async (page) => {
      await page.goto(`${ctx.baseUrl}/`, { waitUntil: "domcontentloaded" });

      const open = await page.locator("details.m-account").evaluate((el) => (el as HTMLDetailsElement).open);
      expect(open).toBe(false);
    });
  });

  it("opens when the summary is clicked", async () => {
    await withPage(ctx, user.sid, async (page) => {
      await page.goto(`${ctx.baseUrl}/`, { waitUntil: "domcontentloaded" });

      await page.locator("summary.m-account-trigger").click();

      const open = await page.locator("details.m-account").evaluate((el) => (el as HTMLDetailsElement).open);
      expect(open).toBe(true);
    });
  });

  it("shows the user's name in the trigger", async () => {
    // The header shows the display name when the account has one. A
    // test that only checked for the presence of the menu would pass
    // even if it showed the wrong name — which is exactly the bug
    // that made a renamed account look like the save had failed.
    await withPage(ctx, user.sid, async (page) => {
      await page.goto(`${ctx.baseUrl}/`, { waitUntil: "domcontentloaded" });

      const label = (await page.locator(".m-account-name").textContent())?.trim();
      expect(label).toBe("张三");
    });
  });

  it("offers the four account actions", async () => {
    await withPage(ctx, user.sid, async (page) => {
      await page.goto(`${ctx.baseUrl}/`, { waitUntil: "domcontentloaded" });
      await page.locator("summary.m-account-trigger").click();

      const hrefs = await page
        .locator(".m-account-menu a")
        .evaluateAll((els) => els.map((el) => (el as HTMLAnchorElement).getAttribute("href")));
      expect(hrefs).toContain("/dashboard");
      expect(hrefs).toContain("/dashboard/profile/details");
      expect(hrefs).toContain("/dashboard/profile/password");

      // Logout is a form submission, not a link — it mutates server
      // state, so it carries a CSRF token.
      const logoutMethod = await page
        .locator('.m-account-form button[type="submit"]')
        .evaluate((el) => (el as HTMLButtonElement).form?.getAttribute("method"));
      expect((logoutMethod ?? "").toLowerCase()).toBe("post");
    });
  });

  it("closes again when the summary is clicked a second time", async () => {
    await withPage(ctx, user.sid, async (page) => {
      await page.goto(`${ctx.baseUrl}/`, { waitUntil: "domcontentloaded" });

      await page.locator("summary.m-account-trigger").click();
      expect(await page.locator("details.m-account").evaluate((el) => (el as HTMLDetailsElement).open)).toBe(
        true,
      );

      await page.locator("summary.m-account-trigger").click();
      expect(await page.locator("details.m-account").evaluate((el) => (el as HTMLDetailsElement).open)).toBe(
        false,
      );
    });
  });

  it("opens the console when the first item is clicked", async () => {
    // The user's original complaint: the console link in the top right
    // hung. Clicking it must land on the console.
    await withPage(ctx, user.sid, async (page) => {
      await page.goto(`${ctx.baseUrl}/`, { waitUntil: "domcontentloaded" });
      await page.locator("summary.m-account-trigger").click();
      await page.locator('.m-account-menu a[href="/dashboard"]').click();

      await page.waitForURL(/\/dashboard/, { timeout: 15_000 });
      expect(page.url()).toContain("/dashboard");
    });
  });

  it("logs the user out when the logout item is clicked", async () => {
    // Logout is a POST with a CSRF token. The whole flow has to work:
    // click, submit, and the session has to be gone afterwards — the
    // header must show the signed-out links rather than the account
    // menu.
    await withPage(ctx, user.sid, async (page) => {
      await page.goto(`${ctx.baseUrl}/`, { waitUntil: "domcontentloaded" });
      await page.locator("summary.m-account-trigger").click();
      await page.locator('.m-account-form button[type="submit"]').click();

      await page.waitForURL((url) => !url.pathname.startsWith("/dashboard"), { timeout: 15_000 });

      // The session is gone: the account menu is replaced by the
      // signed-out links.
      const menuCount = await page.locator("details.m-account").count();
      const loginCount = await page.locator('a[href="/login"]').count();
      expect(menuCount).toBe(0);
      expect(loginCount).toBeGreaterThan(0);
    });
  });
});

describe("the account menu for an anonymous visitor", () => {
  it("shows the sign-in links instead of the menu", async () => {
    await withPage(ctx, undefined, async (page) => {
      await page.goto(`${ctx.baseUrl}/`, { waitUntil: "domcontentloaded" });

      expect(await page.locator("details.m-account").count()).toBe(0);
      expect(await page.locator('a[href="/login"]').count()).toBeGreaterThan(0);
      expect(await page.locator('a[href="/signup"]').count()).toBeGreaterThan(0);
    });
  });
});
