"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseListQuery = parseListQuery;
exports.appendQueryString = appendQueryString;
const MAX_LIMIT = 200;
function parseListQuery(rawQs, fields) {
    const params = new URLSearchParams(rawQs);
    const filters = {};
    for (const f of fields.filters) {
        const v = params.get(f);
        if (v != null && v !== "")
            filters[f] = v;
    }
    let sort = null;
    const s = params.get("sort");
    if (s) {
        const desc = s.startsWith("-");
        const col = desc ? s.slice(1) : s;
        if (fields.sort.includes(col))
            sort = { col, dir: desc ? "desc" : "asc" };
    }
    const page = Math.max(1, Number(params.get("page")) || 1);
    const limit = Math.min(MAX_LIMIT, Math.max(1, Number(params.get("limit")) || 25));
    const idsParam = params.get("ids");
    const ids = idsParam
        ? idsParam
            .split(",")
            .map((s) => Number(s.trim()))
            .filter((n) => Number.isFinite(n) && n > 0)
        : [];
    return { filters, sort, page, limit, ids };
}
function appendQueryString(existing, key, value) {
    const sep = existing ? "&" : "";
    return `${existing}${sep}${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
}
//# sourceMappingURL=queryString.js.map