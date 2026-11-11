"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.bootstrapAdmin = bootstrapAdmin;
const password_1 = require("../auth/password");
const users_1 = require("../../storage/users");
async function bootstrapAdmin(pool, opts) {
    const v = (0, password_1.validatePassword)(opts.password);
    if (!v.ok) {
        const msg = v.reason === "too_short"
            ? "password must be at least 10 characters"
            : v.reason === "no_letter"
                ? "password must contain at least one letter"
                : "password must contain at least one digit";
        throw new Error(msg);
    }
    const passwordHash = await (0, password_1.hashPassword)(opts.password);
    const displayName = opts.displayName ?? opts.email;
    const existing = await (0, users_1.findUserByEmail)(pool, opts.email);
    if (existing) {
        await pool.query("UPDATE users SET password_hash = ?, role = ?, email_verified = 1 WHERE email = ?", [
            passwordHash,
            "admin",
            opts.email,
        ]);
        return { id: existing.id };
    }
    const created = await (0, users_1.createUser)(pool, {
        email: opts.email,
        passwordHash,
        displayName,
        role: "admin",
    });
    await pool.query("UPDATE users SET email_verified = 1 WHERE id = ?", [created.id]);
    return { id: created.id };
}
//# sourceMappingURL=bootstrap.js.map