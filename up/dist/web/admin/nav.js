"use strict";
// SPDX-License-Identifier: MIT
//
// The admin console's information architecture lives here — one source of
// truth for BOTH the sidebar and the topbar breadcrumb.
//
// Why this file exists
// --------------------
// The navigation used to be a list of ten <a> tags written directly into
// sidebar.hbs, with each group's membership decided by indentation. The
// result was a grouping that did not match what the pages actually do:
//
//   · /admin/audit is a per-query log (query_log rows), but it sat in
//     "用户与治理" next to /admin/audit-log, which is an admin-action
//     audit. Two pages both called "审计", in the same group, reading
//     completely different tables.
//   · /admin/settings configures the API port, the DB pool, secrets and
//     the ETL schedule. It is platform configuration, not user governance.
//   · /admin/queries (aggregate traffic metrics) and /admin/keys
//     (credential lifecycle) shared a "流量与凭证" group — one is
//     observability, the other is identity.
//   · /admin/users, the only true governance page, was buried at the
//     bottom of that same four-item group.
//
// The four groups below follow the work, not the URL prefix: what an
// operator is trying to do when they open the page.
//
//   监控与流量   — is the service healthy, what is it being asked
//   数据管道     — where the address data comes from and how it is loaded
//   访问与身份   — who may call the API and with which credential
//   系统与治理   — what changed, and how the instance is configured
//
// `findAdminNav` also feeds the breadcrumb. Detail pages (/admin/users/42,
// /admin/etl/runs/17) resolve to their section, so the operator always
// knows where they are.
Object.defineProperty(exports, "__esModule", { value: true });
exports.ADMIN_NAV_GROUPS = void 0;
exports.isAdminNavActive = isAdminNavActive;
exports.findAdminNav = findAdminNav;
// 16×16 line icons, currentColor, stroke-width inherited from .sidebar-icon.
const ICON_GAUGE = '<path d="M2.5 11.5a8 8 0 1 1 11 0"/><path d="M8 11.5V8"/><path d="M5.5 9.5a4.5 4.5 0 1 1 5 0"/>';
const ICON_CHART = '<path d="M2.5 13.5h11"/><path d="M4.5 10.5v-4"/><path d="M8 10.5v-7"/><path d="M11.5 10.5v-5"/>';
const ICON_LIST = '<path d="M3 4h10"/><path d="M3 8h10"/><path d="M3 12h6"/>';
const ICON_PIPELINE = '<path d="M2.5 4.5h4l1.5 2h5.5"/><path d="M2.5 9.5h4l1.5 2h5.5"/>';
const ICON_DOWNLOAD = '<path d="M8 2.5v7"/><path d="M5 7l3 3 3-3"/><path d="M2.5 12.5h11"/>';
const ICON_SOURCE = '<path d="M6 2.5v4"/><path d="M10 2.5v4"/><path d="M4 6.5h8v3a4 4 0 0 1-4 4 4 4 0 0 1-4-4z"/>';
const ICON_USERS = '<circle cx="6" cy="5.5" r="2.5"/><path d="M2 13.5c0-2.2 1.8-3.5 4-3.5s4 1.3 4 3.5"/><path d="M11 3.5a2.5 2.5 0 0 1 0 5"/><path d="M12 13.5c0-1.5-.5-2.5-1.3-3.1"/>';
const ICON_KEY = '<circle cx="5.5" cy="8" r="2.5"/><path d="M8 8h5.5"/><path d="M11.5 8v2.5"/><path d="M13.5 8v1.5"/>';
const ICON_SHIELD = '<path d="M8 2.5l5 2v3.5c0 3-2.1 5-5 5.5-2.9-.5-5-2.5-5-5.5V4.5z"/><path d="M6 8l1.5 1.5L10.5 6.5"/>';
const ICON_DOC = '<path d="M4 2.5h6l3 3v8a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-10a1 1 0 0 1 1-1z"/><path d="M5.5 7h5"/><path d="M5.5 9.5h5"/><path d="M5.5 12h3"/>';
const ICON_GEAR = '<circle cx="8" cy="8" r="2"/><path d="M8 1.5v1.8"/><path d="M8 12.7v1.8"/><path d="M1.5 8h1.8"/><path d="M12.7 8h1.8"/><path d="M3.4 3.4l1.3 1.3"/><path d="M11.3 11.3l1.3 1.3"/><path d="M12.6 3.4l-1.3 1.3"/><path d="M4.7 11.3l-1.3 1.3"/>';
exports.ADMIN_NAV_GROUPS = [
    {
        key: "monitor",
        labelKey: "nav.admin.groups.monitor",
        items: [
            { href: "/admin", labelKey: "nav.admin.dashboard", icon: ICON_GAUGE, match: "exact" },
            { href: "/admin/queries", labelKey: "nav.admin.queries", icon: ICON_CHART, match: "prefix" },
            // /admin/audit must be exact: /admin/audit-log starts with the same
            // characters but belongs to a different group.
            { href: "/admin/audit", labelKey: "nav.admin.audit", icon: ICON_LIST, match: "exact" },
        ],
    },
    {
        key: "data",
        labelKey: "nav.admin.groups.data",
        items: [
            { href: "/admin/etl/runs", matchPath: "/admin/etl", labelKey: "nav.admin.etl", icon: ICON_PIPELINE, match: "prefix" },
            { href: "/admin/ingest", labelKey: "nav.admin.ingest", icon: ICON_DOWNLOAD, match: "prefix" },
            { href: "/admin/providers", labelKey: "nav.admin.providers", icon: ICON_SOURCE, match: "prefix" },
        ],
    },
    {
        key: "access",
        labelKey: "nav.admin.groups.access",
        items: [
            { href: "/admin/users", labelKey: "nav.admin.users", icon: ICON_USERS, match: "prefix" },
            { href: "/admin/keys", labelKey: "nav.admin.keys", icon: ICON_KEY, match: "prefix" },
        ],
    },
    {
        key: "system",
        labelKey: "nav.admin.groups.system",
        items: [
            { href: "/admin/audit-log", labelKey: "nav.admin.auditLog", icon: ICON_SHIELD, match: "prefix" },
            { href: "/admin/settings", labelKey: "nav.admin.settings", icon: ICON_GEAR, match: "prefix" },
        ],
    },
];
/** A prefix match must not swallow a sibling path: /admin/audit-log is not
 *  inside /admin/audit, and /admin/keys is not inside /admin/key. Requiring
 *  a "/" boundary after the href keeps both true. */
function isAdminNavActive(path, href, match) {
    const normalized = path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
    if (match === "exact")
        return normalized === href;
    return normalized === href || normalized.startsWith(`${href}/`);
}
/** Resolves a request path to its group and item, longest match path first
 *  so a detail page resolves to its own section rather than to `/admin`. */
function findAdminNav(path) {
    const normalized = path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
    const candidates = exports.ADMIN_NAV_GROUPS.flatMap((group) => group.items.map((item) => ({ group, item })));
    candidates.sort((left, right) => (right.item.matchPath ?? right.item.href).length -
        (left.item.matchPath ?? left.item.href).length);
    for (const candidate of candidates) {
        const matchPath = candidate.item.matchPath ?? candidate.item.href;
        if (isAdminNavActive(normalized, matchPath, candidate.item.match)) {
            return candidate;
        }
    }
    return null;
}
//# sourceMappingURL=nav.js.map