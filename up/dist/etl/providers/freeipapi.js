"use strict";
// SPDX-License-Identifier: MIT
//
// freeipapi.com provider. Free tier: 60 req/min, no key, HTTPS.
//
// Endpoint:
//   GET https://freeipapi.com/api/json/{ip}
//
// Response shape (the parts we use):
//   { ipAddress, countryCode, countryName, cityName, regionName,
//     latitude, longitude, timeZone, isp, organization, asn }
//
// 429 -> rateLimited=true. Other 4xx/5xx, timeout, or malformed JSON ->
// record=null, rateLimited=false. Never throw; backfill treats null as
// "abstain".
Object.defineProperty(exports, "__esModule", { value: true });
exports.FreeIpApiProvider = void 0;
class FreeIpApiProvider {
    opts;
    name = "freeipapi";
    constructor(opts = {}) {
        this.opts = opts;
    }
    async lookup(ip) {
        const url = `${this.opts.endpoint ?? "https://freeipapi.com"}/api/json/${encodeURIComponent(ip)}`;
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
            if (!data.countryCode) {
                return { record: null, rateLimited: false, errorCode: "no_country" };
            }
            return {
                record: {
                    countryCode: data.countryCode,
                    countryName: data.countryName ?? null,
                    region: data.regionName ?? null,
                    city: data.cityName ?? null,
                    latitude: typeof data.latitude === "number" ? data.latitude : null,
                    longitude: typeof data.longitude === "number" ? data.longitude : null,
                    timezone: data.timeZone ?? null,
                    isp: data.isp ?? null,
                    asn: typeof data.asn === "number" ? data.asn : typeof data.asn === "string" ? Number(data.asn) : null,
                    asnOrg: data.organization ?? null,
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
exports.FreeIpApiProvider = FreeIpApiProvider;
async function safeBody(res) {
    try {
        const text = await res.text();
        return text.length > 240 ? text.slice(0, 240) : text;
    }
    catch {
        return null;
    }
}
//# sourceMappingURL=freeipapi.js.map