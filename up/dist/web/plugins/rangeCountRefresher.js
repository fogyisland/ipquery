"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerRangeCountRefresher = registerRangeCountRefresher;
const rangeCount_1 = require("../../storage/rangeCount");
function registerRangeCountRefresher(app, pool, opts) {
    const intervalMs = opts?.intervalMs ?? rangeCount_1.RANGE_COUNT_MAX_AGE_MS;
    let timer = null;
    // The pool can be re-pointed at runtime by the setup wizard, so it is
    // resolved at call time rather than captured.
    const resolvePool = () => (typeof pool === "function" ? pool() : pool);
    const tick = async () => {
        // No database to count while the server serves the wizard.
        if (app.dbDegraded)
            return null;
        try {
            const stored = await (0, rangeCount_1.readStoredRangeCount)(resolvePool());
            const ageMs = stored?.syncedAt === null || stored?.syncedAt === undefined
                ? Infinity
                : Date.now() - stored.syncedAt.getTime();
            // Nothing to do when the stored value is still fresh — an exact count is
            // expensive enough that refreshing it on a timer for no reason is waste.
            if (ageMs < intervalMs)
                return stored?.value ?? null;
            const fresh = await (0, rangeCount_1.refreshRangeCount)(resolvePool());
            if (fresh)
                app.log.info({ rows: fresh.value }, "range count refreshed");
            return fresh?.value ?? null;
        }
        catch (err) {
            app.log.warn({ err }, "range count refresh failed");
            return null;
        }
    };
    timer = setInterval(() => {
        void tick();
    }, intervalMs);
    timer.unref();
    app.addHook("onClose", async () => {
        if (timer)
            clearInterval(timer);
    });
    return { refreshNow: tick };
}
//# sourceMappingURL=rangeCountRefresher.js.map