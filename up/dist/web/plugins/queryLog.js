"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerQueryLogWriter = registerQueryLogWriter;
const queryLog_1 = require("../../storage/queryLog");
function registerQueryLogWriter(app, pool, opts) {
    const flushIntervalMs = opts?.flushIntervalMs ?? 5000;
    const maxBatch = opts?.maxBatch ?? 100;
    let buffer = [];
    let timer = null;
    async function flush() {
        if (buffer.length === 0)
            return;
        const slice = buffer;
        buffer = [];
        try {
            await (0, queryLog_1.insertQueryLogs)(pool, slice);
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