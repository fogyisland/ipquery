// SPDX-License-Identifier: MIT
//
// The admin filter bar is built entirely from two Handlebars helpers: `hash`
// builds each filter's descriptor, and `array` collects them. Both were
// broken for the lifetime of the feature, and the failure was invisible —
// the page still rendered, so no test failed.
//
// The `hash` helper returned the Handlebars OPTIONS object instead of the
// caller's hash arguments. Its own `name` key was the helper's name, so
// every `<select>` in the filter bar was named "hash" and every label was
// empty. The `array` helper then failed to strip the options object that
// Handlebars appends as the last argument, so that object ended up in the
// array as an extra, bogus filter.
//
// This file renders the real `filter-bar` partial with the real helpers and
// asserts the markup a browser would see.
import { describe, it, expect, beforeAll } from "vitest";
import Fastify from "fastify";
import * as fs from "node:fs";
import * as path from "node:path";
import Handlebars from "handlebars";
import { registerView } from "../../src/web/plugins/view";

const VIEWS_DIR = path.resolve(__dirname, "../../src/web/views");

let filterBarSource = "";

beforeAll(async () => {
  // The helpers live inside the view plugin's `register` hook, so the only
  // way to exercise the REAL implementations is to run the plugin. A copy
  // in the test file would drift from the original — which is exactly how
  // this bug survived.
  const app = Fastify();
  await registerView(app, { baseUrl: "http://localhost" });
  await app.ready();
  await app.close();

  filterBarSource = fs.readFileSync(path.join(VIEWS_DIR, "partials/filter-bar.hbs"), "utf-8");
  Handlebars.registerPartial("filter-bar", filterBarSource);
});

/** Render the filter bar the way the admin views do: the filter list is
 *  passed in as a partial parameter built from `hash` and `array`. */
function renderFilters(filtersExpression: string): string {
  const template = Handlebars.compile(`{{> filter-bar action='/admin/users' filters=${filtersExpression} }}`);
  return template({});
}

/** The three filters the users page declares, in the exact form the view
 *  uses. The `req.t` call is replaced by a literal because the i18n
 *  function is bound to a request scope. */
const USERS_FILTERS = [
  "(array",
  "  (hash name='role' label='角色' options=(array",
  "    (hash value='admin' label='管理员')",
  "    (hash value='user' label='用户')",
  "  ))",
  "  (hash name='disabled' label='已禁用' options=(array",
  "    (hash value='0' label='正常')",
  "    (hash value='1' label='已禁用')",
  "  ))",
  "  (hash name='verified' label='已验证' options=(array",
  "    (hash value='0' label='否')",
  "    (hash value='1' label='是')",
  "  ))",
  ")",
].join(" ");

describe("the admin filter bar", () => {
  it("names each select after the filter, not after the helper", () => {
    const html = renderFilters(USERS_FILTERS);
    const names = [...html.matchAll(/<select name="([^"]*)"/g)].map((m) => m[1]);
    expect(names).toEqual(["role", "disabled", "verified"]);
    // The bug rendered `name="hash"` — the helper's own name — because the
    // helper returned the options object rather than the hash arguments.
    expect(html).not.toContain('name="hash"');
  });

  it("renders each filter's label", () => {
    const html = renderFilters(USERS_FILTERS);
    const labels = [...html.matchAll(/class="filter-label">\s*([^<\n]+)/g)].map((m) => m[1]!.trim());
    expect(labels).toEqual(["角色", "已禁用", "已验证"]);
    expect(html).not.toContain(">hash");
  });

  it("renders every option of every filter", () => {
    const html = renderFilters(USERS_FILTERS);
    for (const value of ["admin", "user", "0", "1"]) {
      expect(html).toContain(`value="${value}"`);
    }
    for (const optionLabel of ["管理员", "用户", "正常", "否", "是"]) {
      expect(html).toContain(optionLabel);
    }
  });

  it("does not leak the Handlebars options object into the filter list", () => {
    const html = renderFilters(USERS_FILTERS);
    // The options object carries `hash`, `data` and `loc` keys. If the
    // `array` helper failed to strip it, it would show up as a fourth
    // filter with an empty name.
    expect(html).not.toContain("loc=");
    expect(html).not.toContain('data-root');
    const selects = (html.match(/<select name=/g) ?? []).length;
    expect(selects).toBe(3);
  });

  it("renders a single filter without breaking", () => {
    const html = renderFilters(
      "(array (hash name='revoked' label='已吊销' options=(array (hash value='yes' label='是'))))",
    );
    const names = [...html.matchAll(/<select name="([^"]*)"/g)].map((m) => m[1]);
    expect(names).toEqual(["revoked"]);
  });
});
