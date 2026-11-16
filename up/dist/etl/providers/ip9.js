"use strict";
// SPDX-License-Identifier: MIT
//
// ip9.com.cn provider. Free tier: 60 req/min from a single source IP, no
// key, no daily cap. Chinese-language results down to the district level.
//
//   GET https://ip9.com.cn/get?ip={ip}
//   → { ret: 200, data: { country: "中国", prov: "广东省",
//                         city: "深圳市", area: "南山区",
//                         isp: "电信", ip: "1.2.3.4" } }
//
// Why this one alongside ip.sb: the two cover different halves of the
// library. ip.sb is a global English source with ASN data; ip9 answers
// Chinese addresses with province / city / district that the English
// sources get wrong at city level. Neither is authoritative alone — the
// consensus still decides.
//
// Constraints worth remembering (the vendor's, not ours):
//   - 60 req/min is tighter than ip.sb's 100. The backfill serialises
//     per provider, so the burst is one; a future parallel fan-out must
//     not exceed it.
//   - Community-sponsored nodes with no SLA. An abstention is normal and
//     the backfill already tolerates it.
//   - No timezone, no ASN, no coordinates — those stay null and the vote
//     fills them from whoever does answer.
//
// On 429 (or the vendor's own rate-limit signal) we flag
// `rateLimited: true` so the backfill disables the provider rather than
// burning its quota.
Object.defineProperty(exports, "__esModule", { value: true });
exports.Ip9Provider = void 0;
class Ip9Provider {
    opts;
    name = "ip9";
    constructor(opts = {}) {
        this.opts = opts;
    }
    async lookup(ip) {
        const base = this.opts.endpoint ?? "https://ip9.com.cn";
        const url = `${base}/get?ip=${encodeURIComponent(ip)}`;
        let res;
        try {
            res = await fetch(url, {
                signal: AbortSignal.timeout(this.opts.timeoutMs ?? 5_000),
                headers: { "User-Agent": "ipquery-backfill/1.0 (+https://ip.pudafo.com)" },
            });
        }
        catch (err) {
            return {
                record: null,
                rateLimited: false,
                errorCode: err instanceof Error && err.name === "TimeoutError" ? "timeout" : "network",
                rawResponse: err instanceof Error ? err.message : String(err),
            };
        }
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
        let payload;
        try {
            payload = (await res.json());
        }
        catch (err) {
            return {
                record: null,
                rateLimited: false,
                errorCode: "bad_json",
                rawResponse: err instanceof Error ? err.message : String(err),
            };
        }
        // The vendor signals a refused request in the body with ret !== 200.
        // Treating it as a plain abstention would hide a rate limit behind an
        // "empty answer" and keep hammering a provider that said stop.
        if (payload.ret !== undefined && payload.ret !== 200) {
            const message = typeof payload.msg === "string" ? payload.msg : "";
            const limited = /频繁|限制|rate|limit|429/i.test(message) || payload.ret === 429;
            return {
                record: null,
                rateLimited: limited,
                errorCode: limited ? "429" : `ret_${payload.ret}`,
                rawResponse: await safeBody(res),
            };
        }
        const data = payload.data ?? {};
        const countryName = clean(data.country);
        const countryCode = countryNameToCode(countryName);
        if (!countryCode) {
            // The consensus gates on the country code; a record without one is
            // an abstention wearing a record's clothes.
            return { record: null, rateLimited: false, errorCode: "no_country", rawResponse: null };
        }
        // ip9 splits the address into province / city / district. The schema
        // has `region` and `city`; the district is more specific than the city
        // and is what makes a Chinese answer useful, so it goes into `city`
        // when present and the city name moves to `region` only if there is
        // no province.
        const province = clean(data.prov);
        const city = clean(data.city);
        const district = clean(data.area);
        const region = province ?? (city && district ? city : null);
        const cityValue = district ?? city;
        const record = {
            countryCode,
            countryName,
            region,
            city: cityValue,
            // ip9's free tier returns neither coordinates nor a timezone; the
            // consensus fills those from the providers that do.
            latitude: null,
            longitude: null,
            timezone: null,
            isp: clean(data.isp),
            asn: null,
            asnOrg: null,
        };
        return { record, rateLimited: false };
    }
}
exports.Ip9Provider = Ip9Provider;
/** Trim, and treat an empty string as absent. */
function clean(value) {
    if (typeof value !== "string")
        return null;
    const trimmed = value.trim();
    return trimmed === "" || trimmed === "0" ? null : trimmed;
}
/**
 * Chinese country names → ISO codes.
 *
 * ip9 answers in Chinese. The consensus compares country codes, so the
 * mapping has to happen here — and it has to cover the names ip9 actually
 * emits, not a sample. Anything unresolvable is an abstention rather than
 * a guess.
 */
const COUNTRY_NAME_TO_CODE = {
    中国: "CN",
    美国: "US",
    日本: "JP",
    韩国: "KR",
    英国: "GB",
    德国: "DE",
    法国: "FR",
    俄罗斯: "RU",
    加拿大: "CA",
    澳大利亚: "AU",
    巴西: "BR",
    印度: "IN",
    新加坡: "SG",
    马来西亚: "MY",
    泰国: "TH",
    越南: "VN",
    印度尼西亚: "ID",
    菲律宾: "PH",
    荷兰: "NL",
    意大利: "IT",
    西班牙: "ES",
    瑞士: "CH",
    瑞典: "SE",
    挪威: "NO",
    丹麦: "DK",
    芬兰: "FI",
    波兰: "PL",
    爱尔兰: "IE",
    奥地利: "AT",
    比利时: "BE",
    葡萄牙: "PT",
    希腊: "GR",
    土耳其: "TR",
    以色列: "IL",
    阿联酋: "AE",
    沙特阿拉伯: "SA",
    南非: "ZA",
    埃及: "EG",
    尼日利亚: "NG",
    墨西哥: "MX",
    阿根廷: "AR",
    智利: "CL",
    哥伦比亚: "CO",
    秘鲁: "PE",
    新西兰: "NZ",
    乌克兰: "UA",
    捷克: "CZ",
    罗马尼亚: "RO",
    匈牙利: "HU",
    中国香港: "HK",
    中国澳门: "MO",
    中国台湾: "TW",
    香港: "HK",
    澳门: "MO",
    台湾: "TW",
};
function countryNameToCode(name) {
    if (!name)
        return null;
    return COUNTRY_NAME_TO_CODE[name] ?? null;
}
/** Read a response body for the audit log without letting a read failure
 *  turn into a lookup failure. */
async function safeBody(res) {
    try {
        const text = await res.text();
        return text.length > 512 ? `${text.slice(0, 512)}…` : text;
    }
    catch {
        return null;
    }
}
//# sourceMappingURL=ip9.js.map