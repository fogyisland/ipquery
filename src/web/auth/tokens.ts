// SPDX-License-Identifier: MIT
import * as crypto from "node:crypto";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function randomBase32(bytes: number): string {
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

export function generateToken(bytes = 32): string {
  return randomBase32(bytes);
}

export function hashToken(plain: string): string {
  return crypto.createHash("sha256").update(plain, "utf8").digest("hex");
}

export function generateCsrf(): string {
  return crypto.randomBytes(32).toString("hex");
}

export function verifyCsrf(presented: string, expected: string, issuedAt: number, ttlMs: number): boolean {
  if (!presented || !expected) return false;
  if (presented !== expected) return false;
  if (Date.now() - issuedAt > ttlMs) return false;
  return true;
}

export function generateApiKey(): string {
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
export function signCsrfBinding(secret: string, nonce: string): string {
  return crypto.createHmac("sha256", secret).update(nonce, "utf8").digest("hex");
}
