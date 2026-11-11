"use strict";
// SPDX-License-Identifier: MIT
//
// GenericHttpProvider — instantiates at runtime from an ingest_providers
// row where is_custom=1. Replaces the URL template with the queried IP
// and (if set) the stored API key, makes the HTTP request, parses the
// JSON response using dot-path field mappings, and returns a normal
// IpGeoLookupResult so it joins the rest of the pipeline untouched.
Object.defineProperty(exports, "__esModule", { value: true });
exports.GenericHttpProvider = void 0;
const ip_1 = require("../ip");
const ssrf_1 = require("../storage/ssrf");
class GenericHttpProvider {
    row;
    name;
    constructor(row) {
        this.row = row;
        this.name = row.name;
    }
    async lookup(ipOrBuffer) {
        const ipStr = typeof ipOrBuffer === "string" ? ipOrBuffer : (0, ip_1.bufferToString)(ipOrBuffer);
        const apiKey = this.row.apiKey ?? null;
        const url = this.row.urlTemplate
            .replaceAll("{ip}", encodeURIComponent(ipStr))
            .replaceAll("{apiKey}", encodeURIComponent(apiKey ?? ""));
        // SSRF re-check before each request (defends against DNS rebinding).
        const ssrf = await (0, ssrf_1.assertSafeHttpUrl)(url);
        if (!ssrf.ok) {
            return { record: null, rateLimited: false, errorCode: "SSRF_BLOCKED", rawResponse: ssrf.reason };
        }
        const timeoutMs = this.row.timeoutMs ?? 5000;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const init = {
                method: this.row.method,
                signal: controller.signal,
                headers: { "User-Agent": "IPQuery/1.0 (+custom-provider)" },
            };
            if (this.row.method === "POST" && this.row.requestBody) {
                const body = this.row.requestBody.replaceAll("{ip}", ipStr).replaceAll("{apiKey}", apiKey ?? "");
                init.body = body;
                init.headers["Content-Type"] = "application/json";
            }
            const res = await fetch(url, init);
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
            const body = await res.text();
            if (this.row.responseFormat === "text" || body.length > 100_000) {
                return this.parseTextFallback(body);
            }
            let json;
            try {
                json = JSON.parse(body);
            }
            catch {
                return this.parseTextFallback(body);
            }
            const get = (path) => (path ? readPath(json, path) : undefined);
            const countryRaw = get(this.row.countryPath);
            const countryCode = countryRaw != null ? String(countryRaw).toUpperCase().slice(0, 2) : "";
            const cityRaw = get(this.row.cityPath);
            const city = cityRaw != null ? String(cityRaw) : "";
            const asnRaw = get(this.row.asnPath);
            const asn = asnRaw != null && asnRaw !== "" ? Number(asnRaw) : null;
            if (!countryCode || countryCode === "UN") {
                return { record: null, rateLimited: false, errorCode: "NO_COUNTRY", rawResponse: body.slice(0, 240) };
            }
            return {
                record: {
                    countryCode,
                    countryName: "",
                    region: null,
                    city,
                    latitude: null,
                    longitude: null,
                    timezone: null,
                    isp: null,
                    asn: Number.isFinite(asn) ? asn : null,
                    asnOrg: null,
                },
                rateLimited: false,
            };
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            const code = msg.includes("abort") ? "timeout" : "network";
            return { record: null, rateLimited: false, errorCode: code, rawResponse: msg.slice(0, 240) };
        }
        finally {
            clearTimeout(timer);
        }
    }
    parseTextFallback(body) {
        // Best-effort: regex out a 2-letter country code from the response.
        const m = body.match(/\b([A-Z]{2})\b/);
        if (m && m[1]) {
            return {
                record: {
                    countryCode: m[1],
                    countryName: "",
                    region: null,
                    city: "",
                    latitude: null,
                    longitude: null,
                    timezone: null,
                    isp: null,
                    asn: null,
                    asnOrg: null,
                },
                rateLimited: false,
            };
        }
        return { record: null, rateLimited: false, errorCode: "PARSE_FAIL", rawResponse: body.slice(0, 240) };
    }
}
exports.GenericHttpProvider = GenericHttpProvider;
async function safeBody(res) {
    try {
        const text = await res.text();
        return text.length > 240 ? text.slice(0, 240) : text;
    }
    catch {
        return null;
    }
}
function readPath(obj, path) {
    // Dot path: a.b.c -> obj['a']['b']['c']. Returns undefined if any segment missing.
    if (obj == null || typeof obj !== "object")
        return undefined;
    let cur = obj;
    for (const seg of path.split(".")) {
        if (cur == null || typeof cur !== "object")
            return undefined;
        cur = cur[seg];
    }
    return cur;
}
//# sourceMappingURL=genericHttpProvider.js.map