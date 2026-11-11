"use strict";
// SPDX-License-Identifier: MIT
//
// ipapi.co provider. Free tier: 30k req/month (~1k/day), HTTPS, no key
// required. The free endpoint is officially "for testing/development";
// third-party uptime trackers have reported intermittent outages, so
// majority-vote across other providers is still the source of truth.
//
// Endpoint:
//   GET https://ipapi.co/{ip}/json/
//
// Response shape (the parts we use):
//   { ip, country_code, country_name, city, region, region_code,
//     postal, latitude, longitude, timezone, asn, org }
//
// asn is a string like "AS15169"; we strip the AS prefix and parse the
// number. org is the display name. 429 -> rateLimited=true. Other
// 4xx/5xx, timeout, or malformed JSON -> record=null, rateLimited=false.
Object.defineProperty(exports, "__esModule", { value: true });
exports.IpapiCoProvider = void 0;
class IpapiCoProvider {
    opts;
    name = "ipapi-co";
    constructor(opts = {}) {
        this.opts = opts;
    }
    async lookup(ip) {
        const url = `${this.opts.endpoint ?? "https://ipapi.co"}/${encodeURIComponent(ip)}/json/`;
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
            if (data.error) {
                return {
                    record: null,
                    rateLimited: false,
                    errorCode: "api_error",
                    rawResponse: JSON.stringify(data).slice(0, 240),
                };
            }
            if (!data.country_code) {
                return { record: null, rateLimited: false, errorCode: "no_country" };
            }
            return {
                record: {
                    countryCode: data.country_code,
                    countryName: data.country_name ?? null,
                    region: data.region ?? null,
                    city: data.city ?? null,
                    latitude: typeof data.latitude === "number" ? data.latitude : null,
                    longitude: typeof data.longitude === "number" ? data.longitude : null,
                    timezone: data.timezone ?? null,
                    isp: data.org ?? null,
                    asn: parseAsn(data.asn ?? null),
                    asnOrg: data.org ?? null,
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
exports.IpapiCoProvider = IpapiCoProvider;
async function safeBody(res) {
    try {
        const text = await res.text();
        return text.length > 240 ? text.slice(0, 240) : text;
    }
    catch {
        return null;
    }
}
function parseAsn(raw) {
    if (!raw)
        return null;
    const m = raw.match(/(?:AS)?(\d+)/i);
    if (!m)
        return null;
    const n = Number(m[1]);
    return Number.isFinite(n) && n > 0 ? n : null;
}
//# sourceMappingURL=ipapiCo.js.map