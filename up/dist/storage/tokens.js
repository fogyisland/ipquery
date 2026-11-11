"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createVerification = createVerification;
exports.findVerificationByHash = findVerificationByHash;
exports.findVerificationById = findVerificationById;
exports.consumeVerification = consumeVerification;
exports.createPasswordReset = createPasswordReset;
exports.findPasswordResetByHash = findPasswordResetByHash;
exports.findPasswordResetById = findPasswordResetById;
exports.consumePasswordReset = consumePasswordReset;
function mapVerRow(r) {
    return {
        id: Number(r.id),
        userId: Number(r.user_id),
        tokenHash: r.token_hash,
        expiresAt: r.expires_at,
        consumedAt: r.consumed_at,
        createdAt: r.created_at,
    };
}
function mapResRow(r) {
    return {
        id: Number(r.id),
        userId: Number(r.user_id),
        tokenHash: r.token_hash,
        expiresAt: r.expires_at,
        consumedAt: r.consumed_at,
    };
}
async function createVerification(pool, userId, tokenHash, expiresAt) {
    const [res] = await pool.query(`INSERT INTO email_verifications (user_id, token_hash, expires_at) VALUES (?, ?, ?)`, [userId, tokenHash, expiresAt]);
    const v = await findVerificationById(pool, res.insertId);
    if (!v)
        throw new Error("verification vanished");
    return v;
}
async function findVerificationByHash(pool, tokenHash) {
    const [rows] = await pool.query(`SELECT * FROM email_verifications WHERE token_hash = ?`, [
        tokenHash,
    ]);
    return rows[0] ? mapVerRow(rows[0]) : null;
}
async function findVerificationById(pool, id) {
    const [rows] = await pool.query(`SELECT * FROM email_verifications WHERE id = ?`, [id]);
    return rows[0] ? mapVerRow(rows[0]) : null;
}
async function consumeVerification(pool, id) {
    await pool.query(`UPDATE email_verifications SET consumed_at = NOW(3) WHERE id = ? AND consumed_at IS NULL`, [id]);
}
async function createPasswordReset(pool, userId, tokenHash, expiresAt) {
    const [res] = await pool.query(`INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES (?, ?, ?)`, [userId, tokenHash, expiresAt]);
    const v = await findPasswordResetById(pool, res.insertId);
    if (!v)
        throw new Error("reset vanished");
    return v;
}
async function findPasswordResetByHash(pool, tokenHash) {
    const [rows] = await pool.query(`SELECT * FROM password_resets WHERE token_hash = ?`, [
        tokenHash,
    ]);
    return rows[0] ? mapResRow(rows[0]) : null;
}
async function findPasswordResetById(pool, id) {
    const [rows] = await pool.query(`SELECT * FROM password_resets WHERE id = ?`, [id]);
    return rows[0] ? mapResRow(rows[0]) : null;
}
async function consumePasswordReset(pool, id) {
    await pool.query(`UPDATE password_resets SET consumed_at = NOW(3) WHERE id = ? AND consumed_at IS NULL`, [
        id,
    ]);
}
//# sourceMappingURL=tokens.js.map