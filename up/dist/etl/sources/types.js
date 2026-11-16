"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.newStats = newStats;
function newStats() {
    return {
        rowsEmitted: 0,
        skipped: {
            shortLine: 0,
            headerRow: 0,
            unparseableIp: 0,
            missingCol: 0,
            nonNumericAsn: 0,
            other: 0,
        },
        gunzipErrors: 0,
    };
}
//# sourceMappingURL=types.js.map