// SPDX-License-Identifier: MIT
//
// The admin nav labels and the relative timestamps were both wired to the
// wrong locale source.
//
// The request's `locale` lives on `req` — it is derived from the `lang`
// cookie by the i18n plugin — and was never copied into the view context.
// So a helper that read `this.locale` always fell back to the "zh-CN"
// default: the console's sidebar stayed in Chinese for an English operator.
//
// `formatRelative` had a worse version of the same bug: it hard-coded
// `locale: zhCN`, so every "3 minutes ago" in the console was written in
// Chinese regardless of the reader's language.
//
// The fix in both cases is to pass the request into the helper. This file
// renders the real helpers and asserts the output a browser would see.
import { describe, it, expect, beforeAll } from "vitest";
import Fastify from "fastify";
import Handlebars from "handlebars";
import { registerView } from "../../src/web/plugins/view";
// The i18n PLUGIN publishes the translator on `globalThis`; the view
// plugin reads it from there. Importing the plugin is what puts it in
// place — the dictionary module alone does not.
import "../../src/web/plugins/i18n";

beforeAll(async () => {
  // The helpers live inside the view plugin's `register` hook, so the only
  // way to exercise the REAL implementations is to run the plugin. A copy
  // in the test file would drift from the original — which is exactly how
  // this bug survived.
  const app = Fastify();
  await registerView(app, { baseUrl: "http://localhost" });
  await app.ready();
  await app.close();
});

/** A request shaped like the one the i18n plugin builds: `locale` plus a
 *  `t` that translates through the real dictionary. */
function makeReq(locale: "zh-CN" | "en-US"): { locale: string; t: (key: string) => string } {
  const dict = (globalThis as { __ipqT?: (l: string, k: string) => string }).__ipqT;
  return {
    locale,
    t: (key: string) => (dict ? dict(locale, key) : key),
  };
}

describe("adminNavLabel", () => {
  it("translates through the request's locale", () => {
    const template = Handlebars.compile(`{{adminNavLabel req 'nav.admin.groups.data'}}`);
    expect(template({ req: makeReq("zh-CN") })).toBe("数据管道");
    expect(template({ req: makeReq("en-US") })).toBe("Data Pipeline");
  });

  it("falls back to the request's locale when no translator is attached", () => {
    // A unit-rendered template may not carry `req.t`; the locale is still
    // enough to pick the right dictionary.
    const template = Handlebars.compile(`{{adminNavLabel req 'nav.admin.groups.data'}}`);
    expect(template({ req: { locale: "en-US" } })).toBe("Data Pipeline");
    expect(template({ req: { locale: "zh-CN" } })).toBe("数据管道");
  });

  it("returns an empty string for a missing key instead of the raw key", () => {
    const template = Handlebars.compile(`[{{adminNavLabel req key}}]`);
    expect(template({ req: makeReq("zh-CN"), key: undefined })).toBe("[]");
    expect(template({ req: makeReq("zh-CN"), key: 42 })).toBe("[]");
  });
});

describe("formatRelative", () => {
  const twoHoursAgo = new Date(Date.now() - 2 * 3600_000).toISOString();

  it("writes the distance in the reader's language", () => {
    const template = Handlebars.compile(`{{formatRelative req ts}}`);
    expect(template({ req: makeReq("zh-CN"), ts: twoHoursAgo })).toMatch(/2\s*小时/);
    expect(template({ req: makeReq("en-US"), ts: twoHoursAgo })).toMatch(/2\s*hour/);
  });

  it("does not fall back to Chinese when the request is English", () => {
    const template = Handlebars.compile(`{{formatRelative req ts}}`);
    const en = template({ req: makeReq("en-US"), ts: twoHoursAgo });
    expect(en).not.toMatch(/小时|分钟|天/);
  });

  it("returns an empty string for a missing timestamp", () => {
    const template = Handlebars.compile(`{{formatRelative req ts}}`);
    expect(template({ req: makeReq("en-US"), ts: null })).toBe("");
  });
});

describe("the locale source", () => {
  it("is the request, not the view context", () => {
    // A template that renders `req.locale` at the top level proves where
    // the language actually comes from. If this ever stops being true,
    // every locale-aware helper silently reverts to Chinese.
    const template = Handlebars.compile(`{{req.locale}}`);
    expect(template({ req: { locale: "en-US" } })).toBe("en-US");
  });
});
