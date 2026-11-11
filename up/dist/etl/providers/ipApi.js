"use strict";
// SPDX-License-Identifier: MIT
//
// ip-api.com provider. Free tier: 45 req/min from a single source IP, no
// key. Response shape:
//
//   { status: "success", country: "United States", countryCode: "US",
//     region: "CA", regionName: "California", city: "Mountain View",
//     lat: 37.4192, lon: -122.0574, timezone: "America/Los_Angeles",
//     isp: "Google LLC", org: "Google LLC", as: "AS15169 Google LLC" }
//
// On 429 we flag `rateLimited: true` so the backfill can disable the
// provider instead of wasting the next 50 calls per minute. On any other
// 4xx/5xx or `status: "fail"` we return record=null, rateLimited=false
// (the bucket's backoff will slow subsequent calls and the backfill job
// retries next time).
Object.defineProperty(exports, "__esModule", { value: true });
exports.IpApiProvider = void 0;
class IpApiProvider {
    opts;
    name = "ip-api";
    constructor(opts = {}) {
        this.opts = opts;
    }
    async lookup(ip) {
        const url = `${this.opts.endpoint ?? "http://ip-api.com"}/json/${encodeURIComponent(ip)}?fields=status,country,countryCode,region,regionName,city,lat,lon,timezone,isp,org,as,query`;
        try {
            const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
            if (res.status === 429) {
                return { record: null, rateLimited: true, errorCode: "429", rawResponse: await safeBody(res) };
            }
            if (!res.ok) {
                return {
                    record: null,
                    rateLimited: false,
                    errorCode: String(res.status),
                    rawResponse: await safeBody(res),
                };
            }
            const data = (await res.json());
            if (data.status !== "success") {
                return {
                    record: null,
                    rateLimited: false,
                    errorCode: "parse",
                    rawResponse: JSON.stringify(data).slice(0, 240),
                };
            }
            return {
                record: {
                    countryCode: data.countryCode ?? null,
                    countryName: data.country ?? null,
                    region: data.regionName ?? null,
                    city: data.city ?? null,
                    latitude: typeof data.lat === "number" ? data.lat : null,
                    longitude: typeof data.lon === "number" ? data.lon : null,
                    timezone: data.timezone ?? null,
                    isp: data.isp ?? null,
                    asn: parseAsn(data.as ?? null),
                    asnOrg: extractOrgFromAs(data.as ?? null) ?? data.org ?? null,
                },
                rateLimited: false,
            };
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            const code = msg.includes("timeout") || msg.includes("aborted") ? "timeout" : "network";
            return { record: null, rateLimited: false, errorCode: code, rawResponse: msg.slice(0, 240) };
        }
    }
}
exports.IpApiProvider = IpApiProvider;
/** "AS15169 Google LLC" -> 15169. Tolerates whitespace, "AS"-prefix or
 *  bare numbers. */
function parseAsn(raw) {
    if (!raw)
        return null;
    const m = raw.match(/(?:AS)?(\d+)/i);
    if (!m)
        return null;
    const n = Number(m[1]);
    return Number.isFinite(n) && n > 0 ? n : null;
}
/** Best-effort: read up to 240 bytes of the response body for audit.
 *  Returns null when the body can't be read (stream error, etc). */
async function safeBody(res) {
    try {
        const text = await res.text();
        return text.length > 240 ? text.slice(0, 240) : text;
    }
    catch {
        return null;
    }
}
/** "AS15169 Google LLC" -> "Google LLC". Falls back to whole string if
 *  the leading "ASxxxxx" pattern isn't there. */
function extractOrgFromAs(raw) {
    if (!raw)
        return null;
    const trimmed = raw.replace(/^\s*AS\d+\s*/i, "").trim();
    return trimmed.length > 0 ? trimmed : null;
}
//# sourceMappingURL=ipApi.js.map