// SPDX-License-Identifier: MIT
//
// The account menu must not promise keyboard behaviour it does not have.
//
// The dropdown is a `<details>` element: the browser gives it open/close,
// focus management and Escape-to-close for free, with no JavaScript. What
// it does NOT give is the ARIA "menu" widget's arrow-key navigation —
// `role="menu"` obliges the author to move focus between items with
// Up/Down, and to close the menu on Escape.
//
// This template carried `role="menu"` on the container and `role="menuitem"`
// on each child, but no key handler anywhere (the page's CSP forbids inline
// scripts and there is no controller for this menu). A screen-reader user
// was told "menu", pressed Down, and nothing moved — the promised
// interaction was absent.
//
// The fix is to not claim it. A list of links inside a disclosure is a
// perfectly good widget without the role, and it keeps the browser's
// native Tab navigation, which is what a keyboard user actually expects
// from a list of links.
//
// The rule is narrow on purpose: it forbids `role="menu"` specifically.
// Other roles (`navigation`, `list`, `listitem`) come with their own
// obligations, and some are satisfied natively.
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const TOPNAV = path.resolve(
  __dirname,
  "..",
  "..",
  "src",
  "web",
  "views",
  "partials",
  "marketing",
  "_topnav.hbs",
);

const source = fs.readFileSync(TOPNAV, "utf8");

/**
 * The template's own comments explain WHY the roles are absent, and they
 * necessarily mention the role names. The assertions below are about the
 * MARKUP, so the comments are stripped first — otherwise a comment
 * explaining the absence would fail the check for its absence.
 */
const markup = source.replace(/\{\{!--[\s\S]*?--\}\}/g, "");

describe("The account menu's ARIA roles", () => {
  it("does not claim to be an ARIA menu", () => {
    // `role="menu"` promises arrow-key navigation. There is no key
    // handler for this menu — the page's CSP is `script-src 'self'` and
    // no controller exists for it — so the promise cannot be kept.
    expect(markup).not.toMatch(/role\s*=\s*"menu"/);
  });

  it("does not claim to be an ARIA menuitem", () => {
    // `menuitem` is only valid inside a `menu`. Without the container
    // role, the children are links and buttons, which is what they are.
    expect(markup).not.toMatch(/role\s*=\s*"menuitem/);
  });

  it("still names the account menu's trigger for assistive technology", () => {
    // The <summary> is the trigger. It carries an aria-label because the
    // visible content is the user's NAME — which says nothing about what
    // the control does.
    expect(markup).toMatch(/aria-label="\{\{req\.t 'nav\.account'\}\}"/);
  });

  it("hides the decorative avatar and caret from assistive technology", () => {
    // The avatar's initial is already written next to the name, and the
    // caret is a pure decoration. Reading either aloud adds noise.
    expect(markup).toMatch(/class="m-account-avatar" aria-hidden="true"/);
    expect(markup).toMatch(/class="m-account-caret"[^>]*aria-hidden="true"/);
  });

  it("keeps the log-out as a POST form carrying a CSRF token", () => {
    // Log-out mutates server state. A GET link could be triggered by any
    // third-party <img src="/logout">; a POST needs a token the attacker
    // cannot read.
    expect(markup).toMatch(/method="POST"\s+action="\/logout"/);
    expect(markup).toMatch(/name="csrf"\s+value="\{\{req\.csrfToken\}\}"/);
  });

  it("links the menu to the three profile destinations", () => {
    for (const href of [
      "/dashboard",
      "/dashboard/profile/details",
      "/dashboard/profile/password",
    ]) {
      expect(markup, `the menu is missing ${href}`).toContain(`href="${href}"`);
    }
  });
});
