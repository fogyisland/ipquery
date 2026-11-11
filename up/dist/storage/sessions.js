"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createSession = createSession;
exports.loadSession = loadSession;
exports.destroySession = destroySession;
exports.destroyAllForUser = destroyAllForUser;
exports.destroyAllForUserExcept = destroyAllForUserExcept;
exports.purgeExpired = purgeExpired;
function mapRow(r) {
    return {
        id: r.id,
        userId: Number(r.user_id),
        expiresAt: r.expires_at,
        createdAt: r.created_at,
    };
}
async function createSession(pool, id, userId, expiresAt) {
    await pool.query(`INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)`, [
        id,
        userId,
        expiresAt,
    ]);
    const [rows] = await pool.query(`SELECT * FROM sessions WHERE id = ?`, [id]);
    if (!rows[0])
        throw new Error("session vanished");
    return mapRow(rows[0]);
}
async function loadSession(pool, id) {
    const [rows] = await pool.query(`SELECT * FROM sessions WHERE id = ? AND expires_at > UTC_TIMESTAMP(3)`, [id]);
    return rows[0] ? mapRow(rows[0]) : null;
}
async function destroySession(pool, id) {
    await pool.query(`DELETE FROM sessions WHERE id = ?`, [id]);
}
async function destroyAllForUser(pool, userId) {
    await pool.query(`DELETE FROM sessions WHERE user_id = ?`, [userId]);
}
// Destroy every session for a user EXCEPT the given session id. Used by
// the in-app change-password flow: we want to evict any browser/phone
// the attacker might have stolen a cookie from, without booting the user
// out of their own current browser. The forgot/reset flow still calls
// destroyAllForUser (no current session to preserve there — the user
// is resetting because they forgot the password).
async function destroyAllForUserExcept(pool, userId, keepSid) {
    const [res] = await pool.query(`DELETE FROM sessions WHERE user_id = ? AND id != ?`, [
        userId,
        keepSid,
    ]);
    return res.affectedRows;
}
async function purgeExpired(pool) {
    const [res] = await pool.query(`DELETE FROM sessions WHERE expires_at <= UTC_TIMESTAMP(3)`);
    return res.affectedRows;
}
//# sourceMappingURL=sessions.js.map