// SPDX-License-Identifier: MIT
//
// Unit tests for the sortable-header builder.
//
// The behaviour under test is a bug fix: the admin views used to emit
// "?sort=-id" as the header link, which replaced the entire query
// string. An operator who had filtered /admin/users down to one role
// lost that filter by clicking a column header — and the table silently
// grew back to every row. The links must now carry the rest of the
// query with them.
import { describe, it, expect } from "vitest";
import { buildSortColumns } from "../../src/web/admin/sortColumns";

/** Pull the query string out of a generated href. */
function queryOf(href: string): URLSearchParams {
  return new URLSearchParams(href.replace(/^\?/, ""));
}

describe("buildSortColumns", () => {
  it("keeps the filter and page parameters on every header link", () => {
    const cols = buildSortColumns(["id", "email"], null, {
      role: "admin",
      disabled: "0",
      page: 3,
    });

    for (const col of cols) {
      const q = queryOf(col.href);
      expect(q.get("role")).toBe("admin");
      expect(q.get("disabled")).toBe("0");
      expect(q.get("page")).toBe("3");
    }
  });

  it("starts a new column ascending", () => {
    const cols = buildSortColumns(["id", "email"], null, {});
    expect(queryOf(cols[0]!.href).get("sort")).toBe("id");
    expect(queryOf(cols[1]!.href).get("sort")).toBe("email");
  });

  it("flips the direction when the already-sorted column is clicked again", () => {
    const cols = buildSortColumns(["id", "email"], { col: "id", dir: "asc" }, {});
    expect(queryOf(cols[0]!.href).get("sort")).toBe("-id");

    const cols2 = buildSortColumns(["id", "email"], { col: "id", dir: "desc" }, {});
    expect(queryOf(cols2[0]!.href).get("sort")).toBe("id");
  });

  it("switches to a different column ascending, not descending", () => {
    const cols = buildSortColumns(["id", "email"], { col: "id", dir: "desc" }, {});
    expect(queryOf(cols[1]!.href).get("sort")).toBe("email");
  });

  it("reports which column is sorted and in which direction", () => {
    const cols = buildSortColumns(["id", "email"], { col: "email", dir: "desc" }, {});
    expect(cols[0]!.isActive).toBe(false);
    expect(cols[0]!.dir).toBeNull();
    expect(cols[1]!.isActive).toBe(true);
    expect(cols[1]!.dir).toBe("desc");
  });

  it("reports no active column when the table is unsorted", () => {
    const cols = buildSortColumns(["id", "email"], null, {});
    expect(cols.every((c) => !c.isActive)).toBe(true);
    expect(cols.every((c) => c.dir === null)).toBe(true);
  });

  it("replaces the old sort parameter instead of duplicating it", () => {
    const cols = buildSortColumns(["id", "email"], { col: "email", dir: "desc" }, {
      sort: "-email",
    });
    const q = queryOf(cols[0]!.href);
    expect(q.getAll("sort")).toEqual(["id"]);
  });

  it("drops empty parameters rather than sending blanks", () => {
    const cols = buildSortColumns(["id"], null, { role: "", search: undefined, page: 2 });
    const q = queryOf(cols[0]!.href);
    expect(q.has("role")).toBe(false);
    expect(q.has("search")).toBe(false);
    expect(q.get("page")).toBe("2");
  });

  it("escapes parameter values", () => {
    const cols = buildSortColumns(["id"], null, { search: "a&b=c" });
    const q = queryOf(cols[0]!.href);
    expect(q.get("search")).toBe("a&b=c");
  });
});
