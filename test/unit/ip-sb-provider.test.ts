// SPDX-License-Identifier: MIT
// ip.sb is a free, no-key geolocation API (100 req/min, 5 req/s).
//
// It exists here because the fan-out shrank to two providers, and two is
// the minimum a 2-of-3 vote needs — one abstention and the round is
// undecidable. ip.sb also carries the ASN and organisation fields the
// other two do not both return.
//
// The response shape:
//
//   { ip: "8.8.8.8", country: "US", country_code: "US",
//     city: "Mountain View", region: "California",
//     latitude: 37.4, longitude: -122.0, timezone: "America/Los_Angeles",
//     isp: "Google LLC", asn: 15169, organization: "Google LLC",
//     asn_organization: "Google LLC" }
import { describe, it, expect, vi, afterEach } from "vitest";
import { IpSbProvider } from "../../src/etl/providers/ipSb";

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Stub fetch with one canned response. */
function stubFetch(init: { status?: number; body?: unknown; throws?: Error }) {
  const fn = vi.fn(async () => {
    if (init.throws) throw init.throws;
    const status = init.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => init.body,
      text: async () => JSON.stringify(init.body),
    } as never;
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

describe("IpSbProvider", () => {
  it("maps the ip.sb payload onto an IpGeoRecord", async () => {
    stubFetch({
      body: {
        ip: "8.8.8.8",
        country: "United States",
        country_code: "US",
        region: "California",
        city: "Mountain View",
        latitude: 37.4,
        longitude: -122.0,
        timezone: "America/Los_Angeles",
        isp: "Google LLC",
        asn: 15169,
        organization: "Google LLC",
      },
    });
    const p = new IpSbProvider();
    const out = await p.lookup("8.8.8.8");
    expect(out.rateLimited).toBe(false);
    expect(out.record).toEqual({
      countryCode: "US",
      countryName: "United States",
      region: "California",
      city: "Mountain View",
      latitude: 37.4,
      longitude: -122.0,
      timezone: "America/Los_Angeles",
      isp: "Google LLC",
      asn: 15169,
      asnOrg: "Google LLC",
    });
  });

  it("calls api.ip.sb over HTTPS", async () => {
    const fn = stubFetch({ body: { country_code: "US" } });
    await new IpSbProvider().lookup("8.8.8.8");
    const url = String(fn.mock.calls[0]?.[0]);
    expect(url.startsWith("https://api.ip.sb/")).toBe(true);
    expect(url).toContain("8.8.8.8");
  });

  it("flags 429 so the backfill can disable the provider", async () => {
    stubFetch({ status: 429, body: { error: "rate limited" } });
    const out = await new IpSbProvider().lookup("8.8.8.8");
    expect(out.rateLimited).toBe(true);
    expect(out.record).toBeNull();
  });

  it("reports other HTTP failures without claiming a rate limit", async () => {
    stubFetch({ status: 500, body: "boom" });
    const out = await new IpSbProvider().lookup("8.8.8.8");
    expect(out.rateLimited).toBe(false);
    expect(out.record).toBeNull();
    expect(out.errorCode).toBe("500");
  });

  it("treats a network failure as an abstention, not a crash", async () => {
    stubFetch({ throws: new Error("ECONNRESET") });
    const out = await new IpSbProvider().lookup("8.8.8.8");
    expect(out.rateLimited).toBe(false);
    expect(out.record).toBeNull();
    expect(out.errorCode).toBeTruthy();
  });

  it("returns null for a payload with no country code", async () => {
    stubFetch({ body: { ip: "8.8.8.8" } });
    const out = await new IpSbProvider().lookup("8.8.8.8");
    expect(out.record).toBeNull();
  });
});
