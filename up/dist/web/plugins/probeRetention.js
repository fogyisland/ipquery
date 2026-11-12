"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerProbeRetention = registerProbeRetention;
const randomProbeLog_1 = require("../../storage/randomProbeLog");
function registerProbeRetention(app, pool, opts) {
    const intervalMs = opts?.intervalMs ?? 6 * 60 * 60 * 1000;
    let timer = null;
    // Resolved at call time: the setup wizard can re-point the pool at a
    // different database while the server is running, and a captured pool
    // would keep sweeping the old one.
    const resolvePool = () => (typeof pool === "function" ? pool() : pool);
    const tick = async () => {
        // While the server is in degraded mode there is no database to sweep.
        // Skipping keeps the log clean instead of repeating the same failure
        // every tick on a server that is otherwise working fine.
        if (app.dbDegraded)
            return 0;
        try {
            const target = resolvePool();
            const retentionDays = await (0, randomProbeLog_1.loadRetentionDays)(target);
            if (retentionDays <= 0)
                return 0;
            const purged = await (0, randomProbeLog_1.purgeOldProbes)(target, retentionDays);
            if (purged > 0)
                app.log.info({ purged: purged, retentionDays }, "probeRetention tick");
            return purged;
        }
        catch (err) {
            app.log.error({ err }, "probeRetention tick failed");
            return 0;
        }
    };
    timer = setInterval(() => {
        void tick();
    }, intervalMs);
    timer.unref();
    app.addHook("onClose", async () => {
        // Only stop the timer — deliberately no final tick. The probe log is
        // pure audit data; the next sweep picks up whatever a final sweep
        // would have deleted, and skipping it keeps shutdown independent of
        // the pool's remaining lifetime.
        if (timer)
            clearInterval(timer);
    });
    return { purgeNow: tick };
}
//# sourceMappingURL=probeRetention.js.map