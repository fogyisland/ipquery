"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_LOCALE = exports.SUPPORTED_LOCALES = void 0;
exports.t = t;
exports.parseLocale = parseLocale;
// SPDX-License-Identifier: MIT
const zh_CN_json_1 = __importDefault(require("./zh-CN.json"));
const en_US_json_1 = __importDefault(require("./en-US.json"));
exports.SUPPORTED_LOCALES = ["zh-CN", "en-US"];
exports.DEFAULT_LOCALE = "zh-CN";
const dictionaries = {
    "zh-CN": zh_CN_json_1.default,
    "en-US": en_US_json_1.default,
};
function lookup(dict, key) {
    const parts = key.split(".");
    let cur = dict;
    for (let i = 0; i < parts.length; i++) {
        if (!cur || typeof cur !== "object")
            return undefined;
        const obj = cur;
        const p = parts[i];
        const direct = obj[p];
        if (typeof direct === "string") {
            // String leaf: resolve directly if it's the final segment. If intermediate
            // (e.g. `admin.users.delete` is a string but key continues to `.confirm.title`),
            // fall through to the literal-dotted-key fallback below.
            if (i === parts.length - 1)
                return direct;
        }
        else if (direct && typeof direct === "object") {
            cur = direct;
            continue;
        }
        // Direct segment didn't yield an object. Try literal-dotted-key fallback in
        // the current object — handles JSON files that intermix flat string leaves
        // with nested dotted keys (e.g. both `delete: "..."` and `delete.confirm.title: "..."`).
        const remaining = parts.slice(i).join(".");
        if (typeof obj[remaining] === "string")
            return obj[remaining];
        return undefined;
    }
    if (typeof cur === "string")
        return cur;
    return undefined;
}
function t(locale, key, vars) {
    const raw = lookup(dictionaries[locale] ?? dictionaries[exports.DEFAULT_LOCALE], key) ??
        lookup(dictionaries[exports.DEFAULT_LOCALE], key) ??
        key;
    if (typeof raw !== "string")
        return key;
    if (!vars)
        return raw;
    // When Handlebars invokes a context-method like `{{req.t "k" name=x}}`, the
    // parser leaks the helper path name into vars (`vars.name = 'req.t'`) AND
    // still puts the real hash args under vars.hash (`vars.hash.name = x`). The
    // hash is the user-intended value; ignore vars.hash and skip the bogus
    // parser-leaked top-level keys (they are either the helper name or the
    // reserved HBS option keys `hash`, `data`, `loc`).
    const userVars = vars.hash && typeof vars.hash === "object"
        ? vars.hash
        : vars;
    let s = raw;
    for (const [k, v] of Object.entries(userVars)) {
        if (typeof v !== "string" && typeof v !== "number")
            continue;
        s = s.split(`{${k}}`).join(String(v));
    }
    return s;
}
function parseLocale(raw) {
    if (raw === "en-US")
        return "en-US";
    return exports.DEFAULT_LOCALE;
}
//# sourceMappingURL=index.js.map