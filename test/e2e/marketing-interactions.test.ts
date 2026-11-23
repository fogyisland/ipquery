// SPDX-License-Identifier: MIT
//
// The marketing pages have JavaScript, and until now nothing ran it.
//
// `marketing-tabs.js` drives two interactions on the public pages: the
// example-IP chips on /try fill the input, and the code-block tabs on
// /docs switch the visible pane. Both were inline in the layout at
// some point, and CSP `script-src 'self'` blocked them — the pages
// looked right and did nothing.
//
// Nothing caught that. The unit suite reads the script's source; the
// integration suite renders the HTML and checks the markup is there.
// Neither ever CLICKS. So the file could be deleted from the layout,
// renamed on disk, or throw on load, and every test would still pass
// while the page silently stopped working.
//
// This test clicks. It is the difference between "the script tag is in
// the HTML" and "the feature works in a browser".
//
// NOTE: this project has the `playwright` LIBRARY, not `@playwright/test`
// — so Playwright's `expect` extensions (`toHaveValue`, `toBeVisible`,
// `toHaveAttribute`) do not exist here. Every assertion below is a
// plain vitest `expect` over a value read out of the page.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startE2e, stopE2e, withPage, type E2eContext } from "../helpers/e2e";

let ctx: E2eContext;

beforeAll(async () => {
  ctx = await startE2e("marketing");
}, 120_000);

afterAll(async () => {
  await stopE2e(ctx);
});

/** The current value of an input, read the way a user would see it. */
async function inputValue(page: import("playwright").Page, selector: string): Promise<string> {
  return await page.locator(selector).inputValue();
}

/** Whether an element is actually rendered (not `display:none`). */
async function isVisible(page: import("playwright").Page, selector: string): Promise<boolean> {
  return await page.locator(selector).isVisible();
}

describe("the /try page's example chips", () => {
  it("fills the input when a chip is clicked", async () => {
    await withPage(ctx, undefined, async (page) => {
      await page.goto(`${ctx.baseUrl}/try`, { waitUntil: "domcontentloaded" });

      expect(await inputValue(page, 'input[name="ip"]')).toBe("");

      await page.locator('.m-try-chip[data-ip="1.1.1.1"]').click();

      // The whole point of the chip: one click fills the field.
      expect(await inputValue(page, 'input[name="ip"]')).toBe("1.1.1.1");
    });
  });

  it("fills the input for a different chip", async () => {
    // A chip handler that always wrote the same IP would pass the
    // first test. This one moves.
    await withPage(ctx, undefined, async (page) => {
      await page.goto(`${ctx.baseUrl}/try`, { waitUntil: "domcontentloaded" });

      await page.locator('.m-try-chip[data-ip="114.114.114.114"]').click();
      expect(await inputValue(page, 'input[name="ip"]')).toBe("114.114.114.114");
    });
  });

  it("focuses the input after a chip fills it", async () => {
    // The handler focuses the field so the visitor can hit Enter
    // straight away. Without the focus the click would fill the box
    // and leave the keyboard somewhere else.
    await withPage(ctx, undefined, async (page) => {
      await page.goto(`${ctx.baseUrl}/try`, { waitUntil: "domcontentloaded" });

      await page.locator('.m-try-chip[data-ip="8.8.8.8"]').click();

      const focused = await page.evaluate(() => {
        const el = document.activeElement;
        return el instanceof HTMLInputElement ? el.name : null;
      });
      expect(focused).toBe("ip");
    });
  });
});

describe("the /docs page's code-block tabs", () => {
  it("shows the pane the clicked tab names", async () => {
    await withPage(ctx, undefined, async (page) => {
      await page.goto(`${ctx.baseUrl}/docs`, { waitUntil: "domcontentloaded" });

      // The curl pane starts visible; the others start hidden.
      expect(await isVisible(page, '[data-pane="curl"]')).toBe(true);
      expect(await isVisible(page, '[data-pane="py"]')).toBe(false);

      await page.locator('.m-codeblock-tab[data-tab="py"]').click();

      expect(await isVisible(page, '[data-pane="py"]')).toBe(true);
      expect(await isVisible(page, '[data-pane="curl"]')).toBe(false);
    });
  });

  it("marks the active tab for assistive technology", async () => {
    // The tab switcher sets aria-selected as well as the `active`
    // class. A screen reader announces the selected state, so a
    // switcher that only moved the class would look broken to anyone
    // not using it visually.
    await withPage(ctx, undefined, async (page) => {
      await page.goto(`${ctx.baseUrl}/docs`, { waitUntil: "domcontentloaded" });

      await page.locator('.m-codeblock-tab[data-tab="node"]').click();

      const selected = await page.locator('.m-codeblock-tab[data-tab="node"]').getAttribute("aria-selected");
      const deselected = await page
        .locator('.m-codeblock-tab[data-tab="curl"]')
        .getAttribute("aria-selected");
      expect(selected).toBe("true");
      expect(deselected).toBe("false");
    });
  });

  it("switches back to the first pane", async () => {
    // The switcher must be reversible: a tab that can only be
    // selected once would strand the reader on the last language.
    await withPage(ctx, undefined, async (page) => {
      await page.goto(`${ctx.baseUrl}/docs`, { waitUntil: "domcontentloaded" });

      await page.locator('.m-codeblock-tab[data-tab="js"]').click();
      expect(await isVisible(page, '[data-pane="js"]')).toBe(true);

      await page.locator('.m-codeblock-tab[data-tab="curl"]').click();
      expect(await isVisible(page, '[data-pane="curl"]')).toBe(true);
      expect(await isVisible(page, '[data-pane="js"]')).toBe(false);
    });
  });
});

describe("the marketing layout loads its script", () => {
  it("serves marketing-tabs.js as JavaScript, and the page has no script errors", async () => {
    // A script served as text/plain is refused by the browser, and the
    // page's features die with no visible error. The status and the
    // content-type are what decide it.
    await withPage(ctx, undefined, async (page) => {
      const failed: string[] = [];
      page.on("pageerror", (err) => failed.push(err.message));

      await page.goto(`${ctx.baseUrl}/try`, { waitUntil: "domcontentloaded" });

      const response = await page.request.get(`${ctx.baseUrl}/assets/marketing-tabs.js`);
      expect(response.status()).toBe(200);
      const type = response.headers()["content-type"] ?? "";
      expect(type).toContain("javascript");

      expect(failed).toEqual([]);
    });
  });
});
