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
export declare function buildSortColumns(columns: readonly string[], current: {
    col: string;
    dir: "asc" | "desc";
} | null, params: Record<string, string | number | undefined>): SortColumn[];
/**
 * Build a query string that preserves the current state of a list view —
 * filters, sort direction and page — for a link that is NOT a sort
 * toggle: the CSV export and the pagination links.
 *
 * WHY THIS IS HERE
 *
 * The CSV export used to receive a bare `/admin/users.csv`. Clicking
 * "导出 CSV" on a filtered table downloaded **every** row: the filter
 * was in the page URL, not in the export link, so the export ran
 * unfiltered. The pagination links had the mirror-image problem on
 * /admin/users — the route never computed a queryString at all, so page
 * 2 was unreachable.
 *
 * Both need exactly the same thing: the current parameters, re-serialised
 * without the ones that belong to a specific link. `omit` names those.
 *
 * @param params The current parameters to carry over.
 * @param omit   Keys to drop — `page` for an export (which always returns
 *               the full filtered set), `sort` for a link that sets its own.
 * @returns The query string WITHOUT a leading "?", or "" when empty.
 */
export declare function buildQueryString(params: Record<string, string | number | undefined>, omit?: readonly string[]): string;
