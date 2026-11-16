"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createProgressReporter = createProgressReporter;
function createProgressReporter(opts) {
    const intervalMs = opts.intervalMs ?? 10_000;
    const write = opts.write ?? ((line) => console.log(line));
    let done = 0;
    let lastPrintedAt = Date.now();
    let startedAt = lastPrintedAt;
    const formatDuration = (seconds) => {
        if (!Number.isFinite(seconds) || seconds < 0)
            return "?";
        const whole = Math.round(seconds);
        const minutes = Math.floor(whole / 60);
        const rest = whole % 60;
        return minutes > 0 ? `${minutes}m${String(rest).padStart(2, "0")}s` : `${rest}s`;
    };
    const render = (final) => {
        const elapsedSec = (Date.now() - startedAt) / 1000;
        const rate = elapsedSec > 0 ? done / elapsedSec : 0;
        const parts = [`[etl] ${opts.label}`];
        if (opts.total !== undefined && opts.total > 0) {
            const pct = Math.min(100, (done / opts.total) * 100);
            parts.push(`${done.toLocaleString()}/${opts.total.toLocaleString()} ${opts.unit} (${pct.toFixed(1)}%)`);
            const remaining = opts.total - done;
            if (rate > 0 && remaining > 0) {
                parts.push(`eta ${formatDuration(remaining / rate)}`);
            }
        }
        else {
            parts.push(`${done.toLocaleString()} ${opts.unit}`);
        }
        parts.push(`${Math.round(rate).toLocaleString()} ${opts.unit}/s`);
        parts.push(`elapsed ${formatDuration(elapsedSec)}`);
        if (final)
            parts.push("done");
        return parts.join(" · ");
    };
    return {
        tick(count) {
            done += count;
            const now = Date.now();
            if (now - lastPrintedAt < intervalMs)
                return;
            lastPrintedAt = now;
            write(render(false));
        },
        finish() {
            write(render(true));
        },
    };
}
//# sourceMappingURL=progressReporter.js.map