"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.setSessionCookie = setSessionCookie;
exports.clearSessionCookie = clearSessionCookie;
exports.isDashboardPath = isDashboardPath;
exports.isAdminPath = isAdminPath;
exports.registerAuthGuards = registerAuthGuards;
const render_1 = require("../errors/render");
const COOKIE_BASE = { httpOnly: true, sameSite: "lax", path: "/" };
async function setSessionCookie(reply, sid, maxAgeSec, secure, domain) {
    reply.setCookie("sid", sid, { ...COOKIE_BASE, maxAge: maxAgeSec, secure, domain: domain || undefined });
}
async function clearSessionCookie(reply, domain) {
    reply.setCookie("sid", "", { ...COOKIE_BASE, maxAge: 0, domain: domain || undefined });
}
function isDashboardPath(url) {
    return url === "/dashboard" || url.startsWith("/dashboard/");
}
function isAdminPath(url) {
    return url === "/admin" || url.startsWith("/admin/");
}
async function registerAuthGuards(app) {
    app.addHook("onRequest", async (req, reply) => {
        const url = req.routeOptions?.url ?? req.url;
        if (isDashboardPath(url)) {
            if (!req.user)
                return reply.code(302).redirect(`/login?next=${encodeURIComponent(req.url)}`);
            if (req.user.isDisabled)
                return reply.code(302).redirect("/login?disabled=1");
        }
        else if (isAdminPath(url)) {
            // A signed-out visitor without the admin role is answered with 404,
            // not 403. The two cases are indistinguishable from the outside, and
            // 403 would confirm that /admin exists and that /admin/users,
            // /admin/settings, … are real routes — a free map of the admin console
            // for anyone who signs up. The console's existence is not a secret to
            // an operator, but it need not be a directory listing for every
            // registered user.
            if (!req.user || req.user.role !== "admin")
                return (0, render_1.sendErrorPage)(reply, 404, "notFound");
            if (req.user.isDisabled)
                return reply.code(302).redirect("/login?disabled=1");
        }
    });
}
//# sourceMappingURL=auth.js.map