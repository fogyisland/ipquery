"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerInitGuard = registerInitGuard;
const settings_1 = require("../../storage/settings");
const SETUP_PATH = "/init";
const SETUP_COMPLETE_PATH = "/init/complete";
// Public routes that must remain reachable while the wizard is up. Adding a
// new public API route? Add it here too, otherwise initGuard will redirect
// it to /init and external integrations / probes will break.
const PUBLIC_API_PATHS = new Set(["/healthz", "/lookup", "/stats"]);
const ASSETS_PREFIX = "/assets/";
function isAllowedUrl(url) {
    if (url === SETUP_PATH)
        return true;
    if (url.startsWith(`${SETUP_PATH}/`))
        return true;
    if (PUBLIC_API_PATHS.has(url))
        return true;
    if (url.startsWith(ASSETS_PREFIX))
        return true;
    return false;
}
function isSetupCompletePath(url, method) {
    return url === SETUP_COMPLETE_PATH && method === "POST";
}
async function registerInitGuard(app) {
    const initialized = await (0, settings_1.isInitialized)(app.pool);
    app.decorate("requireSetup", !initialized);
    app.addHook("onRequest", async (req, reply) => {
        const url = (req.routeOptions?.url ?? req.url);
        const pathOnly = url.split("?")[0];
        if (app.requireSetup) {
            if (isAllowedUrl(pathOnly))
                return;
            return reply.code(302).header("Location", "/init").send();
        }
        if (pathOnly === SETUP_PATH || pathOnly.startsWith(`${SETUP_PATH}/`)) {
            return reply.code(404).send("Not Found");
        }
    });
    app.addHook("onResponse", async (req, reply) => {
        if (!isSetupCompletePath(req.url.split("?")[0], req.method))
            return;
        // Only skip on 4xx/5xx: `POST /init/complete` returns 302, and that
        // redirect is the entire point of the hook (the wizard has just called
        // `markInitialized(app.pool)` and we need to flip the boot-cached flag
        // before the user's next request). Skipping on 3xx left the cache stale
        // and `/login` got redirected back to `/init`.
        if (reply.statusCode >= 400)
            return;
        const fresh = await (0, settings_1.isInitialized)(app.pool);
        app.requireSetup = !fresh;
    });
}
//# sourceMappingURL=initGuard.js.map