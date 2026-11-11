"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerCsrf = registerCsrf;
exports.verifyCsrfRequest = verifyCsrfRequest;
const tokens_1 = require("../auth/tokens");
const CSRF_TTL_MS = 4 * 60 * 60 * 1000;
// HMAC key for the csrf_bind cookie. When CSRF_SECRET is unset we
// fall back to the session secret (also config-driven). Dev/test
// still works without env vars; production should always set
// CSRF_SECRET (see server.ts fail-fast check).
function resolveSecret(app) {
    const w = app.cfg.web;
    if (w.csrfSecret)
        return w.csrfSecret;
    if (w.sessionSecret)
        return w.sessionSecret;
    return "ipquery-dev-csrf-fallback-do-not-use-in-prod";
}
async function registerCsrf(app) {
    app.decorateRequest("csrfToken", "");
    const cookieSecure = Boolean(app.cfg.web.cookieSecure);
    app.addHook("onRequest", async (req, reply) => {
        const secret = resolveSecret(app);
        let token = req.cookies?.csrf ?? "";
        let bind = req.cookies?.csrf_bind ?? "";
        const issuedRaw = req.cookies?.csrf_issued;
        const issued = issuedRaw ? Number(issuedRaw) : 0;
        // Rotate when: any cookie missing, expired, or the binding no
        // longer matches the nonce (browser cleared cookies, csrfSecret
        // rotated, etc.). The HMAC binds the nonce to the server-side
        // secret — the bind cookie is httpOnly + secure so XSS can't
        // exfiltrate it via document.cookie.
        let needsRotate = !token || !bind || !issued || Date.now() - issued > CSRF_TTL_MS;
        if (!needsRotate && (0, tokens_1.signCsrfBinding)(secret, token) !== bind) {
            needsRotate = true;
        }
        if (needsRotate) {
            token = (0, tokens_1.generateCsrf)();
            const now = Date.now();
            reply.setCookie("csrf", token, { httpOnly: false, sameSite: "lax", path: "/", secure: cookieSecure });
            reply.setCookie("csrf_issued", String(now), {
                httpOnly: false,
                sameSite: "lax",
                path: "/",
                secure: cookieSecure,
            });
            const binding = (0, tokens_1.signCsrfBinding)(secret, token);
            reply.setCookie("csrf_bind", binding, {
                httpOnly: true,
                sameSite: "lax",
                path: "/",
                secure: cookieSecure,
                maxAge: Math.floor(CSRF_TTL_MS / 1000),
            });
            bind = binding;
        }
        req.csrfToken = token;
    });
}
function verifyCsrfRequest(req) {
    const cookieToken = req.cookies?.csrf;
    const bind = req.cookies?.csrf_bind;
    const body = (req.body ?? {});
    const bodyToken = typeof body.csrf === "string" ? body.csrf : undefined;
    if (!cookieToken || !bodyToken || !bind)
        return false;
    if (cookieToken !== bodyToken)
        return false;
    const issued = req.cookies?.csrf_issued ? Number(req.cookies.csrf_issued) : 0;
    if (!issued || Date.now() - issued > CSRF_TTL_MS)
        return false;
    // Recompute HMAC over (secret, csrf_nonce) and compare to the
    // httpOnly bind cookie. A stolen csrf cookie (XSS read of
    // document.cookie) is useless — the attacker still needs the
    // httpOnly csrf_bind value to POST successfully, and they can't
    // compute it without knowing CSRF_SECRET.
    const secret = resolveSecret(req.server);
    return (0, tokens_1.signCsrfBinding)(secret, cookieToken) === bind;
}
//# sourceMappingURL=csrf.js.map