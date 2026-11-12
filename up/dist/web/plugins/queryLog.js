"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerQueryLogWriter = registerQueryLogWriter;
const queryLog_1 = require("../../storage/queryLog");
function registerQueryLogWriter(app, pool, opts) {
    const flushIntervalMs = opts?.flushIntervalMs ?? 5000;
    const maxBatch = opts?.maxBatch ?? 100;
    let buffer = [];
    let timer = null;
    // Resolved at call time: the setup wizard can re-point the pool at a
    // different database while the server is running, and a captured pool
    // would keep writing query logs to the old one.
    const resolvePool = () => (typeof pool === "function" ? pool() : pool);
    async function flush() {
        if (buffer.length === 0)
            return;
        const slice = buffer;
        buffer = [];
        // While the server is in degraded mode there is nowhere to write
        // these rows. Dropping them is correct: the requests they describe
        // were answered with 503s from the setup-only mode, not real lookups,
        // so there is nothing to record. Attempting the insert would fail on
        // every flush and log the same error every five seconds.
        if (app.dbDegraded)
            return;
        try {
            await (0, queryLog_1.insertQueryLogs)(resolvePool(), slice);
        }
        catch (err) {
            app.log.error({ err, count: slice.length }, "queryLog flush failed");
        }
    }
    timer = setInterval(() => {
        void flush();
    }, flushIntervalMs);
    timer.unref();
    app.addHook("onResponse", async (req, _reply) => {
        if (!req.pendingLog)
            return;
        buffer.push(req.pendingLog);
        if (buffer.length >= maxBatch)
            await flush();
    });
    app.addHook("onClose", async () => {
        if (timer)
            clearInterval(timer);
        await flush();
    });
    return { flush };
}
//# sourceMappingURL=queryLog.js.map