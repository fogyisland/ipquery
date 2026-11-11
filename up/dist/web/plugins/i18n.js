"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerI18n = registerI18n;
const i18n_1 = require("../i18n");
globalThis.__ipqT = i18n_1.t;
async function registerI18n(app) {
    app.decorateRequest("locale", "zh-CN");
    app.decorateRequest("t", null);
    app.addHook("onRequest", async (req) => {
        const raw = req.cookies?.lang;
        req.locale = (0, i18n_1.parseLocale)(raw);
        req.t = (key, vars) => (0, i18n_1.t)(req.locale, key, vars);
    });
}
//# sourceMappingURL=i18n.js.map