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
exports.generateToken = generateToken;
exports.hashToken = hashToken;
exports.generateCsrf = generateCsrf;
exports.verifyCsrf = verifyCsrf;
exports.generateApiKey = generateApiKey;
exports.signCsrfBinding = signCsrfBinding;
// SPDX-License-Identifier: MIT
const crypto = __importStar(require("node:crypto"));
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function randomBase32(bytes) {
    const buf = crypto.randomBytes(bytes);
    let bits = 0;
    let value = 0;
    let out = "";
    for (const b of buf) {
        value = (value << 8) | b;
        bits += 8;
        while (bits >= 5) {
            bits -= 5;
            out += BASE32_ALPHABET[(value >> bits) & 0x1f];
        }
    }
    if (bits > 0) {
        out += BASE32_ALPHABET[(value << (5 - bits)) & 0x1f];
    }
    return out;
}
function generateToken(bytes = 32) {
    return randomBase32(bytes);
}
function hashToken(plain) {
    return crypto.createHash("sha256").update(plain, "utf8").digest("hex");
}
function generateCsrf() {
    return crypto.randomBytes(32).toString("hex");
}
function verifyCsrf(presented, expected, issuedAt, ttlMs) {
    if (!presented || !expected)
        return false;
    if (presented !== expected)
        return false;
    if (Date.now() - issuedAt > ttlMs)
        return false;
    return true;
}
function generateApiKey() {
    return `ipq_${randomBase32(32)}`;
}
/** HMAC-bind a CSRF nonce to the server-side secret. The nonce travels
 *  in the cookie (readable by JS) AND in the form body; the HMAC
 *  lives in a SECOND cookie that's httpOnly + secure. On verify,
 *  recompute the HMAC and compare it to the bind cookie.
 *
 *  This is the "double submit cookie" pattern hardened against XSS
 *  exfiltration of the readable nonce (because the nonce alone is
 *  useless without the httpOnly HMAC). Rotating CSRF_SECRET
 *  invalidates all outstanding CSRF tokens; the cookie TTL (4h) caps
 *  the blast radius of a leaked nonce. */
function signCsrfBinding(secret, nonce) {
    return crypto.createHmac("sha256", secret).update(nonce, "utf8").digest("hex");
}
//# sourceMappingURL=tokens.js.map