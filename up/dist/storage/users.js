"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createUser = createUser;
exports.findUserByEmail = findUserByEmail;
exports.findUserById = findUserById;
exports.getUserPasswordHash = getUserPasswordHash;
exports.markEmailVerified = markEmailVerified;
exports.setDisabled = setDisabled;
exports.updatePassword = updatePassword;
exports.updateDisplayName = updateDisplayName;
exports.updateEmail = updateEmail;
exports.setLastLogin = setLastLogin;
exports.deleteUser = deleteUser;
exports.listUsers = listUsers;
function mapRow(r) {
    return {
        id: Number(r.id),
        email: r.email,
        displayName: r.display_name,
        role: r.role,
        emailVerified: Boolean(r.email_verified),
        isDisabled: Boolean(r.is_disabled),
        createdAt: r.created_at,
        lastLoginAt: r.last_login_at,
    };
}
async function createUser(pool, input) {
    const [res] = await pool.query(`INSERT INTO users (email, password_hash, display_name, role) VALUES (?, ?, ?, ?)`, [input.email, input.passwordHash, input.displayName, input.role ?? "user"]);
    const u = await findUserById(pool, res.insertId);
    if (!u)
        throw new Error("user vanished after insert");
    return u;
}
async function findUserByEmail(pool, email) {
    const [rows] = await pool.query(`SELECT * FROM users WHERE email = ?`, [email]);
    return rows[0] ? mapRow(rows[0]) : null;
}
async function findUserById(pool, id) {
    const [rows] = await pool.query(`SELECT * FROM users WHERE id = ?`, [id]);
    return rows[0] ? mapRow(rows[0]) : null;
}
async function getUserPasswordHash(pool, userId) {
    const [rows] = await pool.query(`SELECT password_hash FROM users WHERE id = ?`, [userId]);
    return rows[0] ? rows[0].password_hash : null;
}
async function markEmailVerified(pool, userId) {
    await pool.query(`UPDATE users SET email_verified = 1 WHERE id = ?`, [userId]);
}
async function setDisabled(pool, userId, disabled) {
    await pool.query(`UPDATE users SET is_disabled = ? WHERE id = ?`, [disabled ? 1 : 0, userId]);
}
async function updatePassword(pool, userId, newHash) {
    await pool.query(`UPDATE users SET password_hash = ? WHERE id = ?`, [newHash, userId]);
}
async function updateDisplayName(pool, userId, name) {
    await pool.query(`UPDATE users SET display_name = ? WHERE id = ?`, [name, userId]);
}
async function updateEmail(pool, userId, email) {
    await pool.query(`UPDATE users SET email = ?, email_verified = 0 WHERE id = ?`, [email, userId]);
}
async function setLastLogin(pool, userId) {
    await pool.query(`UPDATE users SET last_login_at = NOW(3) WHERE id = ?`, [userId]);
}
async function deleteUser(pool, userId) {
    await pool.query(`DELETE FROM users WHERE id = ?`, [userId]);
}
async function listUsers(pool, opts) {
    const where = [];
    const params = [];
    if (opts.search) {
        where.push("email LIKE ?");
        params.push(`%${opts.search}%`);
    }
    if (opts.role) {
        where.push("role = ?");
        params.push(opts.role);
    }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const [rows] = await pool.query(`SELECT * FROM users ${whereSql} ORDER BY id DESC LIMIT ? OFFSET ?`, [...params, opts.limit, opts.offset]);
    const [totalRows] = await pool.query(`SELECT COUNT(*) AS c FROM users ${whereSql}`, params);
    return {
        rows: rows.map(mapRow),
        total: Number(totalRows[0].c),
    };
}
//# sourceMappingURL=users.js.map