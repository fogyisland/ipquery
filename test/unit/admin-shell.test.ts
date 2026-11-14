// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import zhCN from "../../src/web/i18n/zh-CN.json";
import enUS from "../../src/web/i18n/en-US.json";

const CSS = path.join(__dirname, "..", "..", "src", "web", "assets", "css", "admin.css");
const LAYOUT = path.join(__dirname, "..", "..", "src", "web", "views", "layouts", "admin.hbs");

function lookup(dict: Record<string, unknown>, dotted: string): unknown {
  return dotted.split(".").reduce<unknown>((node, part) => {
    if (!node || typeof node !== "object") return undefined;
    return (node as Record<string, unknown>)[part];
  }, dict);
}

describe("commercial admin console shell", () => {
  it("pins the light palette and does not flip with OS dark mode", () => {
    const css = fs.readFileSync(CSS, "utf8");
    expect(css).toContain("color-scheme: light;");
    expect(css).not.toContain("@media (prefers-color-scheme: light)");
    expect(css).toContain("--accent: #0e7490;");
  });

  it("defines every colour used by the shell as a token", () => {
    const css = fs.readFileSync(CSS, "utf8");
    for (const token of [
      "--on-accent",
      "--on-danger",
      "--accent-soft",
      "--danger-dim",
      "--shadow-card",
    ]) {
      expect(css, `${token} must be defined`).toContain(`${token}:`);
    }
    // The old dark-theme glow outlines and neon accents are gone.
    expect(css).not.toContain("#22d3ee");
    expect(css).not.toContain("#062028");
  });

  it("keeps the admin topbar and breadcrumb in the layout", () => {
    const layout = fs.readFileSync(LAYOUT, "utf8");
    expect(layout).toContain("{{> admin-topbar}}");
    expect(layout).toContain("admin-workspace");
    expect(layout).toContain("IPQuery Console");
    expect(layout).toContain('content="#f5f7fa"');
  });

  it("re-skins submit buttons so they share the teal accent", () => {
    // forms.css styles `button[type="submit"]` on its own, and that
    // selector beats `.btn-primary` on specificity — without an explicit
    // override the filter buttons stay cyan while everything else moves
    // to the accent colour.
    const css = fs.readFileSync(CSS, "utf8");
    expect(css).toContain('.layout-admin button[type="submit"]');
    expect(css).toContain('.layout-admin button[type="submit"].btn-primary');
    // The primary submit button paints the accent token, not the old cyan.
    const primary = css.slice(
      css.indexOf('.layout-admin button[type="submit"].btn-primary'),
    );
    expect(primary.slice(0, primary.indexOf("}"))).toContain("background: var(--accent)");
    expect(primary.slice(0, primary.indexOf("}"))).toContain("color: var(--on-accent)");
  });

  it("keeps the layout properties of the rules it restyled", () => {
    // A bulk restyle of the type treatment once replaced whole rule
    // bodies and silently dropped `display`, `padding` and `margin`,
    // which collapsed the settings tab row into inline text. Guard the
    // declarations those rules depend on.
    const css = fs.readFileSync(CSS, "utf8");
    const rule = (selector: string): string => {
      const start = css.indexOf(`\n${selector} {`);
      expect(start, `${selector} must exist`).toBeGreaterThan(-1);
      const open = css.indexOf("{", start);
      const close = css.indexOf("}", open);
      return css.slice(open, close);
    };
    expect(rule(".settings-tab-link")).toContain("display: inline-flex");
    expect(rule(".settings-tab-link")).toContain("padding: 10px 16px");
    expect(rule(".settings-tab-link")).toContain("border-bottom: 2px solid transparent");
    expect(rule(".dash-section-title")).toContain("display: flex");
    expect(rule(".dash-section-title")).toContain("margin: var(--sp-5) 0 var(--sp-3)");
    expect(rule(".sidebar-group-label")).toContain("padding: 0 var(--sp-5) var(--sp-2)");
    expect(rule(".probe-log-table thead th")).toContain("text-align: left");
  });

  it("does not leave a mangled transition declaration behind", () => {
    const css = fs.readFileSync(CSS, "utf8");
    // A mangled declaration reads "border-color 80ms ease;" — a duration
    // with a value but no property name. Every legitimate transition
    // value line follows a "transition:" declaration.
    const lines = css.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!.trim();
      if (!/^\S+ 80ms ease;$/.test(line)) continue;
      // Walk back to the declaration that opened the value list.
      let j = i - 1;
      while (j >= 0 && lines[j]!.trim() !== "" && !lines[j]!.trim().endsWith(":")) j--;
      expect(lines[j]!.trim(), `line ${i + 1}: ${line}`).toBe("transition:");
    }
  });

  it("translates the new product chrome in both locales", () => {
    const required = [
      "admin.product",
      "admin.topbar.operational",
      "admin.topbar.viewSite",
      "nav.admin.groups.monitor",
      "nav.admin.groups.data",
      "nav.admin.groups.access",
      "nav.admin.groups.system",
    ];
    for (const key of required) {
      expect(lookup(zhCN as Record<string, unknown>, key), `zh ${key}`).toEqual(expect.any(String));
      expect(lookup(enUS as Record<string, unknown>, key), `en ${key}`).toEqual(expect.any(String));
    }
  });

  it("gives every shell the same accent colour", () => {
    // The product is one product: the console, the wizard and the
    // sign-in pages share one teal. forms.css cannot reference a CSS
    // variable (the shells that load it define none), so the value is
    // written out — and this test is what keeps the three copies equal.
    const read = (name: string): string =>
      fs.readFileSync(
        path.join(__dirname, "..", "..", "src", "web", "assets", "css", name),
        "utf8",
      );

    const admin = read("admin.css");
    const init = read("init.css");
    const forms = read("forms.css");

    expect(admin).toContain("--accent: #0e7490;");
    expect(init).toContain("--boot-accent: #0e7490;");

    // The submit button rule: take the block and check the colour it paints.
    const start = forms.indexOf("button[type=\"submit\"],");
    expect(start).toBeGreaterThan(-1);
    const block = forms.slice(start, forms.indexOf("}", start));
    expect(block).toContain("background: #0e7490;");
    expect(block).toContain("color: #ffffff;");
    // The old terminal button was a 2px-radius monospace chip.
    expect(block).toContain("border-radius: 8px;");
    // Check the declared font stack, not the block as a whole — the block's
    // comment mentions "monospace" when explaining what it replaced.
    const fontFamily = block.slice(block.indexOf("font-family:"));
    expect(fontFamily).not.toContain("monospace");
  });

  it("leaves no terminal accent anywhere in the stylesheets", () => {
    // The console used to be a dark NOC skin: cyan #22d3ee on near-black.
    // The cyan lived in forms.css (every submit button) and layout.css
    // (a dead .setup-step.active rule), so re-skinning admin.css alone
    // left the sign-in pages still wearing the old terminal accent.
    const assetsDir = path.join(__dirname, "..", "..", "src", "web", "assets");
    const stylesheets: string[] = [];
    const collect = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) collect(full);
        else if (entry.name.endsWith(".css")) stylesheets.push(full);
      }
    };
    collect(assetsDir);
    expect(stylesheets.length).toBeGreaterThan(0);
    for (const file of stylesheets) {
      const css = fs.readFileSync(file, "utf8");
      expect(css, `${path.basename(file)} must not use the terminal cyan`).not.toContain("#22d3ee");
      expect(css, `${path.basename(file)} must not use the terminal ink`).not.toContain("#062028");
    }
  });

  it("pins the product to a light canvas across every shell", () => {
    // base.css used to declare `color-scheme: light dark` and repaint the
    // body under the OS dark preference, which left the sign-in form
    // wearing dark inputs inside a light page.
    const base = fs.readFileSync(
      path.join(__dirname, "..", "..", "src", "web", "assets", "css", "base.css"),
      "utf8",
    );
    expect(base).toContain("color-scheme: light;");
    expect(base).not.toContain("color-scheme: light dark;");
    expect(base).not.toContain("@media (prefers-color-scheme: dark)");

    // The sign-in surface needs its own statement, because it loads
    // base.css and forms.css and nothing after them.
    const layout = fs.readFileSync(
      path.join(__dirname, "..", "..", "src", "web", "assets", "css", "layout.css"),
      "utf8",
    );
    expect(layout).toContain("body.layout-auth");
    expect(layout).toContain("color-scheme: light;");
  });
});
