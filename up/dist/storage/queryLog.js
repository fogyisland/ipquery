"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.insertQueryLogs = insertQueryLogs;
exports.listQueryLogs = listQueryLogs;
exports.countQueriesByStatusSince = countQueriesByStatusSince;
exports.getLastUserQuery = getLastUserQuery;
exports.countQueriesByDay = countQueriesByDay;
exports.streamQueryLogsCsv = streamQueryLogsCsv;
async function insertQueryLogs(pool, entries) {
    if (entries.length === 0)
        return;
    const CHUNK = 200;
    for (let i = 0; i < entries.length; i += CHUNK) {
        const slice = entries.slice(i, i + CHUNK);
        const values = [];
        const placeholders = slice
            .map((e) => {
            values.push(e.ip, e.ipText, e.status, e.userId, e.apiKeyId, e.sessionId, e.remoteAddr, e.userAgent);
            return "(?,?,?,?,?,?,?,?)";
        })
            .join(",");
        await pool.query(`INSERT INTO query_log (ip, ip_text, status, user_id, api_key_id, session_id, remote_addr, user_agent) VALUES ${placeholders}`, values);
    }
}
/** The only columns `listQueryLogs` may order by. `col` and `dir` are
 *  interpolated into the ORDER BY clause, so the set is enforced here
 *  as well as in the TypeScript type — a caller that passes an
 *  unvalidated string must not be able to inject SQL. */
const SORT_COLUMNS = new Set(["id", "ts"]);
function resolveSortColumn(col) {
    if (!SORT_COLUMNS.has(col)) {
        throw new Error(`listQueryLogs: unsupported sort column ${JSON.stringify(col)}`);
    }
    return col;
}
function mapRow(r) {
    return {
        id: Number(r.id),
        ts: r.ts,
        ip: r.ip,
        ipText: r.ip_text,
        status: r.status,
        userId: r.user_id == null ? null : Number(r.user_id),
        apiKeyId: r.api_key_id == null ? null : Number(r.api_key_id),
        sessionId: r.session_id == null ? null : r.session_id,
        remoteAddr: r.remote_addr == null ? null : r.remote_addr,
        userAgent: r.user_agent,
        userEmail: r.user_email ?? null,
        apiKeyPrefix: r.api_key_prefix ?? null,
    };
}
async function listQueryLogs(pool, q) {
    const where = [];
    const params = [];
    if (q.userId !== undefined) {
        where.push("q.user_id = ?");
        params.push(q.userId);
    }
    if (q.status) {
        where.push("q.status = ?");
        params.push(q.status);
    }
    if (q.ipText) {
        where.push("q.ip_text = ?");
        params.push(q.ipText);
    }
    if (q.startTime) {
        where.push("q.ts >= ?");
        params.push(q.startTime);
    }
    if (q.endTime) {
        where.push("q.ts <= ?");
        params.push(q.endTime);
    }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const orderCol = q.sort ? resolveSortColumn(q.sort.col) : "id";
    const orderDir = q.sort?.dir === "asc" ? "ASC" : "DESC";
    const [rows] = await pool.query(`SELECT q.*, u.email AS user_email, k.key_prefix AS api_key_prefix
       FROM query_log q
       LEFT JOIN users u ON u.id = q.user_id
       LEFT JOIN api_keys k ON k.id = q.api_key_id
       ${whereSql}
       ORDER BY q.${orderCol} ${orderDir}
       LIMIT ? OFFSET ?`, [...params, q.limit, q.offset]);
    const [totalRows] = await pool.query(`SELECT COUNT(*) AS c FROM query_log q ${whereSql}`, params);
    const arr = rows;
    const totalArr = totalRows;
    return {
        rows: arr.map(mapRow),
        total: Number(totalArr[0].c),
    };
}
async function countQueriesByStatusSince(pool, since, opts) {
    const where = ["ts >= ?"];
    const params = [since];
    if (opts?.userId !== undefined) {
        where.push("user_id = ?");
        params.push(opts.userId);
    }
    const [rows] = await pool.query(`SELECT status, COUNT(*) AS c FROM query_log WHERE ${where.join(" AND ")} GROUP BY status`, params);
    const out = { hit: 0, miss: 0, invalid: 0 };
    for (const r of rows) {
        const k = r.status;
        out[k] = Number(r.c);
    }
    return out;
}
// Fetch the user's most recent query_log row, joined to ip_ranges so the
// hero element on /dashboard can show the IP + its resolved country / ASN
// without a second lookup.
async function getLastUserQuery(pool, userId) {
    // LIMIT 1 + subquery join so MySQL picks the index-friendly path
    const [rows] = await pool.query(`SELECT q.ip_text AS ipText, q.status AS status, q.ts AS ts,
            r.country_code AS countryCode, r.country_name AS countryName, r.asn_org AS asnOrg
       FROM query_log q
       LEFT JOIN ip_ranges r
         ON r.start_ip <= q.ip AND r.end_ip >= q.ip
        AND r.country_code IS NOT NULL
      WHERE q.user_id = ?
      ORDER BY q.ts DESC, q.id DESC
      LIMIT 1`, [userId]);
    const arr = rows;
    if (arr.length === 0)
        return null;
    const r = arr[0];
    return {
        ipText: String(r.ipText ?? ""),
        status: r.status,
        ts: r.ts,
        countryCode: r.countryCode ?? null,
        countryName: r.countryName ?? null,
        asnOrg: r.asnOrg ?? null,
    };
}
async function countQueriesByDay(pool, days) {
    // Bucket in UTC end to end. query_log.ts is written with the pool's
    // timezone: "Z" (UTC), so both the `since` bound and the day keys must
    // be UTC too — mixing local-midnight bounds with ISO (UTC) keys shifted
    // every bucket by the server's UTC offset.
    const since = new Date();
    since.setUTCHours(0, 0, 0, 0);
    since.setUTCDate(since.getUTCDate() - (days - 1));
    const [rows] = await pool.query(`SELECT DATE(CONVERT_TZ(ts, @@session.time_zone, '+00:00')) AS d, status, COUNT(*) AS c
       FROM query_log
       WHERE ts >= ?
       GROUP BY d, status
       ORDER BY d ASC`, [since]);
    const byDate = new Map();
    for (const r of rows) {
        const d = r.d instanceof Date ? r.d.toISOString().slice(0, 10) : String(r.d);
        const cur = byDate.get(d) ?? { hit: 0, miss: 0, invalid: 0 };
        const k = r.status;
        cur[k] = Number(r.c);
        byDate.set(d, cur);
    }
    const out = [];
    for (let i = 0; i < days; i++) {
        const d = new Date(since.getTime() + i * 86_400_000);
        const key = d.toISOString().slice(0, 10);
        const c = byDate.get(key) ?? { hit: 0, miss: 0, invalid: 0 };
        out.push({ date: key, ...c, total: c.hit + c.miss + c.invalid });
    }
    return out;
}
async function streamQueryLogsCsv(pool, q, write) {
    const where = [];
    const params = [];
    if (q.userId !== undefined) {
        where.push("q.user_id = ?");
        params.push(q.userId);
    }
    if (q.status) {
        where.push("q.status = ?");
        params.push(q.status);
    }
    if (q.ipText) {
        where.push("q.ip_text = ?");
        params.push(q.ipText);
    }
    if (q.startTime) {
        where.push("q.ts >= ?");
        params.push(q.startTime);
    }
    if (q.endTime) {
        where.push("q.ts <= ?");
        params.push(q.endTime);
    }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    write("id,ts,ip_text,status,user_email,api_key_prefix,remote_addr,user_agent\n");
    const conn = await pool.getConnection();
    try {
        const [stream] = await conn.query(`SELECT q.id, q.ts, q.ip_text, q.status, u.email AS user_email, k.key_prefix AS api_key_prefix,
              HEX(q.remote_addr) AS remote_hex, q.user_agent
         FROM query_log q
         LEFT JOIN users u ON u.id = q.user_id
         LEFT JOIN api_keys k ON k.id = q.api_key_id
         ${whereSql}
         ORDER BY q.id ASC`, params);
        const rows = stream;
        for (const r of rows) {
            const cells = [
                r.id,
                r.ts.toISOString(),
                JSON.stringify(r.ip_text),
                r.status,
                JSON.stringify(r.user_email ?? ""),
                JSON.stringify(r.api_key_prefix ?? ""),
                JSON.stringify(r.remote_hex ?? ""),
                JSON.stringify(r.user_agent ?? ""),
            ];
            write(cells.join(",") + "\n");
        }
    }
    finally {
        conn.release();
    }
}
//# sourceMappingURL=queryLog.js.map