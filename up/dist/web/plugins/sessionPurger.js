"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerSessionPurger = registerSessionPurger;
const sessions_1 = require("../../storage/sessions");
// Periodic cleanup of expired session rows. Sessions are deleted by
// destroySession/destroyAllForUserExcept on logout + password change, but
// sessions that simply expire (TTL elapses without an explicit logout)
// stick around in the table forever otherwise — unbounded growth on a
// long-running install.
//
// Run interval is intentionally generous (1h default). Even at 1h, a
// million-row sessions table takes the same DELETE-by-PK path MySQL uses
// for any other TTL sweep; the index on expires_at keeps it cheap.
//
// Mirrors the queryLog writer's setInterval / .unref / onClose pattern
// (src/web/plugins/queryLog.ts:40) so the timer never blocks process
// shutdown and doesn't pin Node alive on its own.
function registerSessionPurger(app, pool, opts) {
    const intervalMs = opts?.intervalMs ?? 60 * 60 * 1000;
    let timer = null;
    // The pool may be re-pointed at runtime (the setup wizard swaps it when
    // the operator supplies working credentials), so resolve it at call
    // time rather than capturing it. A captured pool would keep sweeping
    // the old database — or the one that was never reachable.
    const resolvePool = () => (typeof pool === "function" ? pool() : pool);
    const tick = async () => {
        // While the server is in degraded mode there is no database to sweep.
        // The tick would fail, and the failure log would repeat every hour on
        // a server that is otherwise working fine — noise that makes a healthy
        // setup-only install look broken. Skip instead.
        if (app.dbDegraded)
            return 0;
        try {
            const n = await (0, sessions_1.purgeExpired)(resolvePool());
            if (n > 0)
                app.log.info({ purged: n }, "sessionPurger tick");
            return n;
        }
        catch (err) {
            app.log.error({ err }, "sessionPurger tick failed");
            return 0;
        }
    };
    timer = setInterval(() => {
        void tick();
    }, intervalMs);
    timer.unref();
    app.addHook("onClose", async () => {
        if (timer)
            clearInterval(timer);
        await tick();
    });
    return { purgeNow: tick };
}
//# sourceMappingURL=sessionPurger.js.map