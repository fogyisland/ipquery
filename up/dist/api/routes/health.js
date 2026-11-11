"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = healthRoute;
async function healthRoute(app) {
    app.get("/healthz", async () => ({ status: "ok" }));
}
//# sourceMappingURL=health.js.map