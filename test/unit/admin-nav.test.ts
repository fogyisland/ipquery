// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import {
  ADMIN_NAV_GROUPS,
  findAdminNav,
  isAdminNavActive,
  type AdminNavItem,
} from "../../src/web/admin/nav";

function itemsOf(groupKey: string): AdminNavItem[] {
  const group = ADMIN_NAV_GROUPS.find((g) => g.key === groupKey);
  if (!group) throw new Error(`missing group ${groupKey}`);
  return [...group.items];
}

describe("admin navigation model", () => {
  it("organises the ten admin pages into four task-oriented groups", () => {
    expect(ADMIN_NAV_GROUPS.map((g) => g.key)).toEqual([
      "monitor",
      "data",
      "access",
      "system",
    ]);
    expect(itemsOf("monitor").map((i) => i.href)).toEqual([
      "/admin",
      "/admin/queries",
      "/admin/audit",
    ]);
    expect(itemsOf("data").map((i) => i.href)).toEqual([
      "/admin/etl/runs",
      "/admin/ingest",
      "/admin/providers",
    ]);
    // /admin/audit (query_log rows) and /admin/audit-log (admin actions)
    // read different tables. They must not sit in the same group.
    expect(itemsOf("access").map((i) => i.href)).toEqual([
      "/admin/users",
      "/admin/keys",
    ]);
    expect(itemsOf("system").map((i) => i.href)).toEqual([
      "/admin/audit-log",
      "/admin/settings",
    ]);
  });

  it("has no duplicate href across groups", () => {
    const hrefs = ADMIN_NAV_GROUPS.flatMap((g) => g.items.map((i) => i.href));
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });

  it("gives every item an icon and an i18n label key", () => {
    for (const item of ADMIN_NAV_GROUPS.flatMap((g) => g.items)) {
      expect(item.icon).toMatch(/^<(path|circle)/);
      expect(item.labelKey).toMatch(/^nav\.admin\./);
    }
    for (const group of ADMIN_NAV_GROUPS) {
      expect(group.labelKey).toMatch(/^nav\.admin\.groups\./);
    }
  });

  it("resolves detail and alias pages to their section", () => {
    const cases: Record<string, string> = {
      "/admin": "/admin",
      "/admin/queries": "/admin/queries",
      "/admin/audit": "/admin/audit",
      "/admin/audit-log": "/admin/audit-log",
      "/admin/etl": "/admin/etl/runs",
      "/admin/etl/runs/17": "/admin/etl/runs",
      "/admin/etl/trigger/confirm": "/admin/etl/runs",
      "/admin/users/42": "/admin/users",
      "/admin/settings#integrations": "/admin/settings",
      "/dashboard": "",
      "/": "",
    };
    for (const [path, expectedHref] of Object.entries(cases)) {
      const clean = path.split("#")[0]!;
      const hit = findAdminNav(clean);
      expect(hit?.item.href ?? "", path).toBe(expectedHref);
    }
  });

  it("does not let a prefix match swallow a sibling path", () => {
    // /admin/audit-log is NOT inside /admin/audit; /admin/keys is not
    // inside /admin/key. Both are exact boundaries or slash-boundary rules.
    expect(isAdminNavActive("/admin/audit-log", "/admin/audit", "exact")).toBe(false);
    expect(isAdminNavActive("/admin/keys", "/admin/key", "prefix")).toBe(false);
    expect(isAdminNavActive("/admin/audit-log", "/admin/audit-log", "prefix")).toBe(true);
    expect(findAdminNav("/admin/audit-log")?.group.key).toBe("system");
    expect(findAdminNav("/admin/audit")?.group.key).toBe("monitor");
  });
});
