// SPDX-License-Identifier: MIT
// One answering provider is enough to write a row.
//
// The backfill used to require a 2-of-N majority on the country code. With
// three providers that meant any two abstentions made a round undecidable —
// and the retired providers contributed nothing but abstentions, so most
// rounds burned the quota and wrote nothing.
//
// A single confident answer is better than no answer. The provider is named
// in `country_source` on the written row, so a later vote can still correct
// it — the row is attributable, not anonymous.
import { describe, it, expect } from "vitest";
import { majorityVote } from "../../src/etl/majority";

/** A full record with the given country. */
function rec(countryCode: string, extra: Partial<Record<string, unknown>> = {}) {
  return {
    countryCode,
    countryName: null,
    region: null,
    city: null,
    latitude: null,
    longitude: null,
    timezone: null,
    isp: null,
    asn: null,
    asnOrg: null,
    ...extra,
  };
}

describe("single-source consensus", () => {
  it("accepts one answered provider when the others abstain", () => {
    const result = majorityVote([
      { provider: "ip-api", record: rec("US") },
      { provider: "ipinfo", record: null },
      { provider: "ip-sb", record: null },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record.countryCode).toBe("US");
  });

  it("still prefers the agreed value when several providers answer", () => {
    const result = majorityVote([
      { provider: "ip-api", record: rec("US", { city: "Los Angeles" }) },
      { provider: "ipinfo", record: rec("US", { city: "Los Angeles" }) },
      { provider: "ip-sb", record: rec("CA", { city: "Toronto" }) },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Country: two agree on US. City: two agree on Los Angeles.
    expect(result.record.countryCode).toBe("US");
    expect(result.record.city).toBe("Los Angeles");
  });

  it("drops a field that only one provider supplies", () => {
    // A lone city is not corroborated, so it stays null — "write NULL rather
    // than something wrong" still holds for the non-gating fields.
    const result = majorityVote([
      { provider: "ip-api", record: rec("US", { city: "Mountain View" }) },
      { provider: "ipinfo", record: rec("US") },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record.countryCode).toBe("US");
    expect(result.record.city).toBeNull();
  });

  it("reports all_abstained when nobody answers", () => {
    const result = majorityVote([
      { provider: "ip-api", record: null },
      { provider: "ip-sb", record: null },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("all_abstained");
  });
});
