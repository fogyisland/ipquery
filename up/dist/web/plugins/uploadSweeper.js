"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerUploadSweeper = registerUploadSweeper;
const rangeUpload_1 = require("../../storage/rangeUpload");
function registerUploadSweeper(app, pool, opts) {
    const intervalMs = opts?.intervalMs ?? 6 * 60 * 60 * 1000;
    let timer = null;
    // The pool may be re-pointed at runtime (the setup wizard swaps it when
    // the operator supplies working credentials), so resolve it at call
    // time rather than capturing it. A captured pool would keep sweeping
    // the old database — or the one that was never reachable.
    const resolvePool = () => (typeof pool === "function" ? pool() : pool);
    const tick = async () => {
        // While the server is in degraded mode there is no database to sweep.
        // The tick would fail, and the failure log would repeat every six
        // hours on a server that is otherwise working fine — noise that
        // makes a healthy setup-only install look broken. Skip instead.
        if (app.dbDegraded)
            return 0;
        try {
            const n = await (0, rangeUpload_1.purgeAbandonedUploads)(resolvePool());
            if (n > 0)
                app.log.info({ purged: n }, "uploadSweeper tick");
            return n;
        }
        catch (err) {
            app.log.error({ err }, "uploadSweeper tick failed");
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
    return { sweepNow: tick };
}
//# sourceMappingURL=uploadSweeper.js.map