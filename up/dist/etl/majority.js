"use strict";
// SPDX-License-Identifier: MIT
//
// Consensus across provider responses for a single IP.
//
// Rules:
// - The country code is the gating field: no country, no row. It does NOT
//   need corroboration — one answered provider is enough. The row records
//   which provider supplied it, so a later run can correct it.
// - For the remaining fields, a value needs two providers behind it. A
//   lone answer is dropped (written as NULL) rather than trusted: the
//   non-gating fields are enrichment, and enrichment that only one source
//   claims is the part most likely to be wrong.
//
// History: this used to be a strict 2-of-3 on the country code too. Once
// the three providers that never answered were retired (migration 028),
// that rule turned every single abstention into a wasted round.
Object.defineProperty(exports, "__esModule", { value: true });
exports.majorityVote = majorityVote;
const FIELDS = [
    "countryCode",
    "countryName",
    "region",
    "city",
    "latitude",
    "longitude",
    "timezone",
    "isp",
    "asn",
    "asnOrg",
];
/** Run majority-vote on responses from the providers that actually
 *  returned a record (null = abstained). The caller passes ALL responses
 *  including nulls so we can report per-provider abstention. */
function majorityVote(responses) {
    const valid = responses.filter((r) => r.record !== null);
    if (valid.length === 0) {
        return {
            ok: false,
            reason: "all_abstained",
            perProvider: Object.fromEntries(responses.map((r) => [r.provider, r.record])),
        };
    }
    // Country code is the gating field: a row with no country is not worth
    // writing. It no longer needs corroboration though.
    //
    // The 2-of-N rule was written when five providers answered; by the time
    // three of them had been retired for never responding, it meant a single
    // abstention made every round undecidable and the backfill spent its
    // quota writing nothing. One confident answer is better than none — the
    // written row records which provider supplied it, so a later run can
    // still correct it, and the fan-out still prefers agreement when there
    // is more than one answer.
    const countryCodeVotes = valid
        .map((r) => r.record.countryCode)
        .filter((c) => typeof c === "string" && c.length > 0);
    if (countryCodeVotes.length === 0) {
        return {
            ok: false,
            reason: "no_country",
            perProvider: Object.fromEntries(responses.map((r) => [r.provider, r.record])),
        };
    }
    const countryWinner = countryCodeVotes.length === 1
        ? { value: countryCodeVotes[0], count: 1 }
        : pickMajority(countryCodeVotes);
    if (!countryWinner) {
        return {
            ok: false,
            reason: "no_consensus",
            perProvider: Object.fromEntries(responses.map((r) => [r.provider, r.record])),
        };
    }
    // For everything else, accept whatever 2+ providers agree on; if no
    // 2-of-3 agreement, drop the field (write NULL).
    const merged = {
        countryCode: countryWinner.value,
        countryName: null,
        region: null,
        city: null,
        latitude: null,
        longitude: null,
        timezone: null,
        isp: null,
        asn: null,
        asnOrg: null,
    };
    const agreement = { countryCode: countryWinner.count };
    for (const field of FIELDS) {
        if (field === "countryCode")
            continue; // already handled
        const values = valid
            .map((r) => r.record[field])
            .filter((v) => v !== null && v !== undefined && v !== "");
        const pick = pickMajority(values);
        if (pick) {
            merged[field] = pick.value;
            agreement[field] = pick.count;
        }
    }
    return { ok: true, record: merged, agreement };
}
function pickMajority(values) {
    if (values.length === 0)
        return null;
    const counts = new Map();
    for (const v of values)
        counts.set(v, (counts.get(v) ?? 0) + 1);
    let best = null;
    for (const [value, count] of counts) {
        if (count >= 2 && (!best || count > best.count)) {
            best = { value, count };
        }
    }
    return best;
}
//# sourceMappingURL=majority.js.map