"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = healthRoute;
const runner_1 = require("../../storage/migrations/runner");
/**
 * Liveness and schema drift, in one response.
 *
 * The status line is the load balancer's question: is this process serving.
 * The `schema` block is the operator's, and it is here because the two are
 * routinely confused — a deployment whose database is a migration behind the
 * code reports `ok` right up to the moment a query touches a column that
 * does not exist. Reporting the pending count turns that silent gap into
 * something a monitor can alert on before a request hits it.
 */
async function healthRoute(app) {
    app.get("/healthz", async () => {
        const report = await (0, runner_1.getSchemaReport)(app.pool);
        return {
            status: "ok",
            schema: { current: report.isCurrent, pending: report.pendingCount },
        };
    });
}
//# sourceMappingURL=health.js.map