"use strict";
// SPDX-License-Identifier: MIT
//
// SSRF guard for custom HTTP providers. Rejects URLs targeting:
// - localhost / 127.0.0.0/8 / ::1
// - private networks: 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16
// - link-local: 169.254.0.0/16, fe80::/10
// - unique-local: fc00::/7
// - 0.0.0.0, broadcast, multicast
// - file://, javascript:, data: schemes
// Also rejects hostnames that resolve to any of the above (DNS check
// at validation time; re-check before each request to defend against
// DNS rebinding — log warning if hostname resolves differently at
// request time but don't block).
//
// Returns { ok: true } | { ok: false, reason: string }.
Object.defineProperty(exports, "__esModule", { value: true });
exports.assertSafeHttpUrl = assertSafeHttpUrl;
const promises_1 = require("node:dns/promises");
const BLOCKED_SCHEMES = new Set(["file:", "javascript:", "data:", "ftp:"]);
async function assertSafeHttpUrl(rawUrl) {
    let url;
    try {
        url = new URL(rawUrl);
    }
    catch {
        return { ok: false, reason: "invalid_url" };
    }
    if (!["http:", "https:"].includes(url.protocol)) {
        return { ok: false, reason: `blocked_scheme_${url.protocol.replace(":", "")}` };
    }
    const hostname = url.hostname;
    if (!hostname)
        return { ok: false, reason: "missing_hostname" };
    // Some platforms resolve "localhost" through the OS hosts file (which
    // doesn't go through the dns/promises module's resolver) — block the
    // bare hostname too so we never trust it.
    if (hostname.toLowerCase() === "localhost")
        return { ok: false, reason: "blocked_hostname_localhost" };
    // Block raw IP literals first (cheaper than DNS).
    if (isBlockedIpLiteral(hostname))
        return { ok: false, reason: `blocked_ip_${hostname}` };
    // Resolve hostname. If it resolves to any blocked IP, refuse.
    let addrs;
    try {
        addrs = await (0, promises_1.lookup)(hostname, { all: true });
    }
    catch {
        return { ok: false, reason: "dns_resolution_failed" };
    }
    for (const a of addrs) {
        if (isBlockedIpLiteral(a.address)) {
            return { ok: false, reason: `resolved_to_blocked_${a.address}` };
        }
    }
    return { ok: true };
}
function isBlockedIpLiteral(ip) {
    // IPv4
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
        const parts = ip.split(".").map(Number);
        const a = parts[0] ?? 0;
        const b = parts[1] ?? 0;
        if (a === 127)
            return true; // 127.0.0.0/8 loopback
        if (a === 10)
            return true; // 10.0.0.0/8 private
        if (a === 172 && b >= 16 && b <= 31)
            return true; // 172.16/12
        if (a === 192 && b === 168)
            return true; // 192.168/16
        if (a === 169 && b === 254)
            return true; // 169.254/16 link-local
        if (a === 0)
            return true; // 0.0.0.0/8
        if (a >= 224)
            return true; // multicast + reserved
        return false;
    }
    // IPv6
    if (ip === "::1" || ip === "::")
        return true;
    if (ip.toLowerCase().startsWith("fc") || ip.toLowerCase().startsWith("fd"))
        return true; // fc00::/7
    if (ip.toLowerCase().startsWith("fe80:"))
        return true; // fe80::/10 link-local
    return false;
}
//# sourceMappingURL=ssrf.js.map