"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createApiKey = createApiKey;
exports.findApiKeyById = findApiKeyById;
exports.findActiveApiKeyByHash = findActiveApiKeyByHash;
exports.touchApiKey = touchApiKey;
exports._resetApiKeyTouchThrottle = _resetApiKeyTouchThrottle;
exports.revokeApiKey = revokeApiKey;
exports.revokeApiKeysBulk = revokeApiKeysBulk;
exports.listApiKeysForUser = listApiKeysForUser;
exports.listAllApiKeys = listAllApiKeys;
exports.countActiveApiKeys = countActiveApiKeys;
function mapRow(r) {
    return {
        id: Number(r.id),
        userId: Number(r.user_id),
        label: r.label,
        keyPrefix: r.key_prefix,
        lastUsedAt: r.last_used_at,
        revokedAt: r.revoked_at,
        createdAt: r.created_at,
    };
}
async function createApiKey(pool, userId, label, keyHash, keyPrefix) {
    const [res] = await pool.query(`INSERT INTO api_keys (user_id, label, key_hash, key_prefix) VALUES (?, ?, ?, ?)`, [userId, label, keyHash, keyPrefix]);
    const k = await findApiKeyById(pool, res.insertId);
    if (!k)
        throw new Error("api key vanished");
    return k;
}
async function findApiKeyById(pool, id) {
    const [rows] = await pool.query(`SELECT * FROM api_keys WHERE id = ?`, [id]);
    return rows[0] ? mapRow(rows[0]) : null;
}
async function findActiveApiKeyByHash(pool, keyHash) {
    const [rows] = await pool.query(`SELECT * FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL`, [keyHash]);
    return rows[0] ? mapRow(rows[0]) : null;
}
/**
 * Throttle for `touchApiKey`.
 *
 * `last_used_at` exists so the dashboard can show when each key was
 * last exercised. Writing it on every request costs a DB round-trip
 * and a row lock per request, which is pure overhead: nobody can
 * perceive the difference between "used 3 seconds ago" and "used 30
 * seconds ago" on a dashboard.
 *
 * Each key is therefore stamped at most once per interval. The stamp
 * is written on the FIRST request after the interval expires, so the
 * value is never more than one interval stale.
 */
const TOUCH_THROTTLE_MS = 60_000;
/** keyId → the timestamp (epoch ms) of the last stamp we wrote. */
const lastTouched = new Map();
async function touchApiKey(pool, id) {
    const now = Date.now();
    const last = lastTouched.get(id);
    if (last !== undefined && now - last < TOUCH_THROTTLE_MS)
        return;
    // Record the intent BEFORE the write. If the write fails, the next
    // request retries rather than waiting out the interval — a failed
    // stamp must not suppress the next one.
    lastTouched.set(id, now);
    try {
        await pool.query(`UPDATE api_keys SET last_used_at = NOW(3) WHERE id = ?`, [id]);
    }
    catch (err) {
        lastTouched.delete(id);
        throw err;
    }
}
/**
 * Clear the throttle state. Test-only.
 */
function _resetApiKeyTouchThrottle() {
    lastTouched.clear();
}
async function revokeApiKey(pool, id) {
    await pool.query(`UPDATE api_keys SET revoked_at = NOW(3) WHERE id = ? AND revoked_at IS NULL`, [id]);
}
/** Bulk-revoke up to 100 keys in one UPDATE. Returns the number of rows
 *  actually revoked (already-revoked keys are no-ops and don't count).
 *  The caller caps the input length; we re-cap defensively in case the
 *  caller forgets. */
async function revokeApiKeysBulk(pool, ids) {
    if (ids.length === 0)
        return 0;
    const capped = ids.slice(0, 100);
    const [res] = await pool.query(`UPDATE api_keys SET revoked_at = NOW(3) WHERE id IN (?) AND revoked_at IS NULL`, [capped]);
    return res.affectedRows;
}
async function listApiKeysForUser(pool, userId) {
    const [rows] = await pool.query(`SELECT * FROM api_keys WHERE user_id = ? ORDER BY id DESC`, [userId]);
    return rows.map(mapRow);
}
async function listAllApiKeys(pool, opts) {
    const where = [];
    const params = [];
    if (opts.userId) {
        where.push("k.user_id = ?");
        params.push(opts.userId);
    }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const [rows] = await pool.query(`SELECT k.*, u.email AS owner_email FROM api_keys k JOIN users u ON u.id = k.user_id ${whereSql} ORDER BY k.id DESC LIMIT ? OFFSET ?`, [...params, opts.limit, opts.offset]);
    const [totalRows] = await pool.query(`SELECT COUNT(*) AS c FROM api_keys k ${whereSql}`, params);
    return {
        rows: rows.map((r) => ({ ...mapRow(r), ownerEmail: r.owner_email })),
        total: Number(totalRows[0].c),
    };
}
async function countActiveApiKeys(pool) {
    const [rows] = await pool.query(`SELECT COUNT(*) AS c FROM api_keys WHERE revoked_at IS NULL`);
    return Number(rows[0].c);
}
//# sourceMappingURL=apiKeys.js.map