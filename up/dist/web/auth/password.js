"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.hashPassword = hashPassword;
exports.verifyPassword = verifyPassword;
exports.validatePassword = validatePassword;
// SPDX-License-Identifier: MIT
const argon2 = __importStar(require("argon2"));
const ARGON_OPTS = {
    type: argon2.argon2id,
    memoryCost: 19456,
    timeCost: 2,
    parallelism: 1,
};
async function hashPassword(plain) {
    return argon2.hash(plain, ARGON_OPTS);
}
async function verifyPassword(hash, plain) {
    try {
        return await argon2.verify(hash, plain);
    }
    catch {
        return false;
    }
}
function validatePassword(plain) {
    if (plain.length < 10)
        return { ok: false, reason: "too_short" };
    if (!/[a-zA-Z]/.test(plain))
        return { ok: false, reason: "no_letter" };
    if (!/[0-9]/.test(plain))
        return { ok: false, reason: "no_digit" };
    return { ok: true };
}
//# sourceMappingURL=password.js.map