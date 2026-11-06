// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { majorityVote } from "../../src/etl/majority";
import type { IpGeoRecord } from "../../src/etl/providers/types";

function rec(overrides: Partial<IpGeoRecord> = {}): IpGeoRecord {
  return {
    countryCode: null,
    countryName: null,
    region: null,
    city: null,
    latitude: null,
    longitude: null,
    timezone: null,
    isp: null,
    asn: null,
    asnOrg: null,
    ...overrides,
  };
}

describe("majorityVote", () => {
  it("returns all_abstained when every provider abstains", () => {
    const r = majorityVote([
      { provider: "a", record: null },
      { provider: "b", record: null },
      { provider: "c", record: null },
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("all_abstained");
  });

  it("fails with no_country when only one provider returned a country code", () => {
    const r = majorityVote([
      { provider: "a", record: rec({ countryCode: "US" }) },
      { provider: "b", record: rec({ countryCode: null }) },
      { provider: "c", record: null },
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("no_country");
  });

  it("fails with no_consensus when country codes disagree 1-1-1", () => {
    const r = majorityVote([
      { provider: "a", record: rec({ countryCode: "US" }) },
      { provider: "b", record: rec({ countryCode: "CA" }) },
      { provider: "c", record: rec({ countryCode: "DE" }) },
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("no_consensus");
  });

  it("passes 2-of-3 on countryCode, drops fields that did not reach 2-of-3", () => {
    const r = majorityVote([
      { provider: "a", record: rec({ countryCode: "US", region: "California", asn: 15169 }) },
      { provider: "b", record: rec({ countryCode: "US", region: "California", asn: 15169 }) },
      { provider: "c", record: rec({ countryCode: "US", region: "Texas", asn: 7922 }) },
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.record.countryCode).toBe("US");
      expect(r.record.region).toBe("California"); // 2-of-3
      expect(r.record.asn).toBe(15169); // 2-of-3
      expect(r.agreement.countryCode).toBe(3);
      expect(r.agreement.region).toBe(2);
      expect(r.agreement.asn).toBe(2);
    }
  });

  it("passes when 2 providers agree and 1 abstains", () => {
    const r = majorityVote([
      { provider: "a", record: rec({ countryCode: "DE" }) },
      { provider: "b", record: rec({ countryCode: "DE" }) },
      { provider: "c", record: null },
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.record.countryCode).toBe("DE");
  });

  it("treats majority-of-two as sufficient when third abstains", () => {
    const r = majorityVote([
      { provider: "a", record: rec({ countryCode: "FR", region: "Île-de-France" }) },
      { provider: "b", record: rec({ countryCode: "FR", region: "IDF" }) },
      { provider: "c", record: null },
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.record.countryCode).toBe("FR");
      // regions disagree across two providers with no tiebreaker -> dropped
      expect(r.record.region).toBeNull();
    }
  });

  it("numeric and string fields both go through pickMajority", () => {
    const r = majorityVote([
      { provider: "a", record: rec({ countryCode: "US", asn: 15169, latitude: 37.4 }) },
      { provider: "b", record: rec({ countryCode: "US", asn: 15169, latitude: 37.4 }) },
      { provider: "c", record: rec({ countryCode: "US", asn: 7922, latitude: 38.0 }) },
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.record.asn).toBe(15169);
      expect(r.record.latitude).toBe(37.4);
    }
  });
});
