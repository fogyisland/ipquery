export type NavMatch = "exact" | "prefix";
/** `icon` is trusted, static SVG inner markup rendered with triple braces.
 *  It is never derived from a request. */
export interface AdminNavItem {
    readonly href: string;
    readonly labelKey: string;
    readonly icon: string;
    readonly match: NavMatch;
    /** Path prefix used for active/breadcrumb resolution when it differs from
     *  `href`. `/admin/etl/runs` is the destination, but the section also owns
     *  `/admin/etl/trigger/confirm` and `/admin/etl/runs/:id`. */
    readonly matchPath?: string;
}
export interface AdminNavGroup {
    readonly key: string;
    readonly labelKey: string;
    readonly items: readonly AdminNavItem[];
}
export declare const ADMIN_NAV_GROUPS: readonly AdminNavGroup[];
/** A prefix match must not swallow a sibling path: /admin/audit-log is not
 *  inside /admin/audit, and /admin/keys is not inside /admin/key. Requiring
 *  a "/" boundary after the href keeps both true. */
export declare function isAdminNavActive(path: string, href: string, match: NavMatch): boolean;
export interface AdminNavLocation {
    readonly group: AdminNavGroup;
    readonly item: AdminNavItem;
}
/** Resolves a request path to its group and item, longest match path first
 *  so a detail page resolves to its own section rather than to `/admin`. */
export declare function findAdminNav(path: string): AdminNavLocation | null;
