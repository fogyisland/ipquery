// src/web/admin/sortColumns.ts
// SPDX-License-Identifier: MIT
//
// Sortable table headers, computed on the server.
//
// WHY THIS EXISTS
//
// The admin views used to build their own sort links inline, with a
// three-level nested ternary per column:
//
//   ?sort={{ternary (eq sort.col 'id')
//     (ternary (eq sort.dir 'asc') '-id' 'id')
//     (ternary (eq sort.dir 'asc') 'id' '-id')}}
//
// Two problems with that, both invisible in the markup:
//
// 1. **The other query parameters were dropped.** A link of the form
//    "?sort=-id" replaces the whole query string, so an operator who
//    filtered the table down to `role=admin` lost that filter the
//    moment they clicked a column header — and the table silently grew
//    back to every row. On /admin/users that means an admin looking at
//    one role suddenly sees all of them, with no way back except
//    retyping the filter.
//
// 2. **There was no direction indicator.** The header link read exactly
//    the same whether the table was sorted ascending or descending, so
//    there was no way to tell what the current order was — you had to
//    read the values and infer it.
//
// This module computes, for each column, the URL that toggles that
// column's direction while preserving the rest of the query, plus the
// current direction so the view can render an arrow.

/** A column the table can be sorted by. */
export interface SortColumn {
  /** The column's query-string key, matching the server's sort whitelist. */
  key: string;
  /** The link target: the query string this column's header should point at. */
  href: string;
  /** "asc" | "desc" when this column is the one currently sorted, else null. */
  dir: "asc" | "desc" | null;
  /** True when this column is the one currently sorted. */
  isActive: boolean;
}

/**
 * Build the sortable-header descriptors for a list view.
 *
 * @param columns  The sortable columns, in display order.
 * @param current  The currently active sort (col + dir), or null.
 * @param params   The query parameters to preserve — filters, page, limit.
 *                 `sort` is handled separately: it is replaced, not merged.
 */
export function buildSortColumns(
  columns: readonly string[],
  current: { col: string; dir: "asc" | "desc" } | null,
  params: Record<string, string | number | undefined>,
): SortColumn[] {
  return columns.map((key) => {
    // Clicking the column that is already sorted flips its direction;
    // clicking a different column starts it ascending. That is the
    // convention every data table uses, and it makes the second click
    // on the same header the "reverse" action without a separate
    // control.
    const isActive = current?.col === key;
    const nextDir: "asc" | "desc" = isActive && current?.dir === "asc" ? "desc" : "asc";

    const search = new URLSearchParams();
    for (const [name, value] of Object.entries(params)) {
      if (value === undefined || value === "") continue;
      // `sort` is set below, from the new direction.
      if (name === "sort") continue;
      search.set(name, String(value));
    }
    search.set("sort", nextDir === "desc" ? `-${key}` : key);

    return {
      key,
      href: `?${search.toString()}`,
      dir: isActive ? (current?.dir ?? null) : null,
      isActive,
    };
  });
}
