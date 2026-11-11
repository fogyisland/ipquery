"use strict";
// SPDX-License-Identifier: MIT
//
// iplocate.io provider. Free tier: 1k req/day with a registered key.
// Response shape:
//
//   { ip: "8.8.8.8", country_code: "US", country_name: "United States",
//     city: "Mountain View", region: "California", latitude: 37.386,
//     longitude: -122.0838, asn: "15169", asn_org: "Google LLC",
//     isp: "Google LLC", timezone: "America/Los_Angeles", is_eu: false }
//
// iplocate splits ASN (number) and ASN org cleanly. 401/403 -> record=null,
// rateLimited=false (bad key, won't fix itself). 429 -> rateLimited=true
// (backfill disables us for this admin session).
Object.defineProperty(exports, "__esModule", { value: true });
exports.IplocateProvider = void 0;
class IplocateProvider {
    opts;
    name = "iplocate";
    constructor(opts = {}) {
        this.opts = opts;
    }
    async lookup(ip) {
        if (!this.opts.apiKey)
            return { record: null, rateLimited: false }; // key missing -> abstain
        const url = `${this.opts.endpoint ?? "https://www.iplocate.io"}/api/v2/lookup/${encodeURIComponent(ip)}`;
        try {
            const res = await fetch(url, {
                headers: { "x-api-key": this.opts.apiKey },
                signal: AbortSignal.timeout(5_000),
            });
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
            return {
                record: {
                    countryCode: data.country_code ?? null,
                    countryName: data.country_name ?? null,
                    region: data.region ?? null,
                    city: data.city ?? null,
                    latitude: typeof data.latitude === "number" ? data.latitude : null,
                    longitude: typeof data.longitude === "number" ? data.longitude : null,
                    timezone: data.timezone ?? null,
                    isp: data.isp ?? null,
                    asn: typeof data.asn === "number" ? data.asn : typeof data.asn === "string" ? Number(data.asn) : null,
                    asnOrg: data.asn_org ?? null,
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
exports.IplocateProvider = IplocateProvider;
async function safeBody(res) {
    try {
        const text = await res.text();
        return text.length > 240 ? text.slice(0, 240) : text;
    }
    catch {
        return null;
    }
}
//# sourceMappingURL=iplocate.js.map