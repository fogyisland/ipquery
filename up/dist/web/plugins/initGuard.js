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
/**
 * Register the setup guard.
 *
 * Two things happen here, and both must happen at BOOT:
 *
 *   1. The `requireSetup` decorator is added. Fastify refuses to add a
 *      decorator after the server has started (FST_ERR_DEC_AFTER_START),
 *      so it cannot be added later from a route handler.
 *
 *   2. The request hooks are installed. Fastify likewise refuses to add
 *      a hook after `ready()` (FST_ERR_INSTANCE_ALREADY_LISTENING).
 *
 * That is why the DEGRADED boot — where the database cannot be reached
 * and the initialization state therefore cannot be read — still calls
 * this function, passing `knownInitialized: false`. The install is by
 * definition uninitialized when there is no database to ask, so the
 * answer is known without asking.
 *
 * The wizard does NOT re-register the guard once it has connected: the
 * hooks are already installed and the `requireSetup` flag is already
 * false for an uninitialized install. What the wizard does flip is
 * `app.dbDegraded`, which is what actually opens the rest of the
 * application — see the gate in src/web/plugins/degradedGate.ts.
 */
async function registerInitGuard(app, opts) {
    const initialized = opts?.knownInitialized ?? (await (0, settings_1.isInitialized)(app.pool));
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
        // A degraded server has no database to re-read. The wizard sets
        // `requireSetup` itself in that case — the guard's job here is to
        // notice that the wizard just completed.
        if (app.dbDegraded)
            return;
        const fresh = await (0, settings_1.isInitialized)(app.pool);
        app.requireSetup = !fresh;
    });
}
//# sourceMappingURL=initGuard.js.map