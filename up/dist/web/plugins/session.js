"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerSession = registerSession;
const sessions_1 = require("../../storage/sessions");
const users_1 = require("../../storage/users");
async function registerSession(app) {
    app.decorateRequest("session", null);
    app.decorateRequest("user", null);
    app.addHook("onRequest", async (req) => {
        const sid = req.cookies?.sid;
        if (!sid)
            return;
        const session = await (0, sessions_1.loadSession)(app.pool, sid);
        if (!session)
            return;
        req.session = session;
        const user = await (0, users_1.findUserById)(app.pool, session.userId);
        req.user = user;
        // Pre-empt Task 9: surface the auth-derived fields on req.session itself so
        // the sidebar partial can render role/email gating without every caller
        // reaching for req.user explicitly.
        if (user) {
            req.session.role = user.role;
            req.session.email = user.email;
        }
    });
}
//# sourceMappingURL=session.js.map