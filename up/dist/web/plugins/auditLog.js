"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerAuditLog = registerAuditLog;
const auditLog_1 = require("../../storage/auditLog");
function registerAuditLog(app) {
    app.decorateRequest("auditAction", null);
    app.addHook("onResponse", async (req, reply) => {
        const audit = req.auditAction;
        if (!audit)
            return;
        if (reply.statusCode >= 400)
            return;
        const user = req.user ?? null;
        try {
            await (0, auditLog_1.recordAuditLog)(app.pool, {
                actor: user ? { id: user.id, email: user.email } : null,
                action: audit.action,
                targetType: audit.targetType,
                targetId: audit.targetId,
                metadata: audit.metadata ?? null,
                ip: req.ip,
                userAgent: req.headers["user-agent"] ?? null,
                statusCode: reply.statusCode,
            });
        }
        catch (err) {
            app.log.error({ err }, "audit log write failed");
        }
    });
}
//# sourceMappingURL=auditLog.js.map