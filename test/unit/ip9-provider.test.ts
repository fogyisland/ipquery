// SPDX-License-Identifier: MIT
// ip9.com.cn is a Chinese-language geolocation API (60 req/min, no key).
//
// It answers with province / city / district for Chinese addresses, which
// the English-language sources get wrong at city level — that precision is
// the reason it is worth a vote.
//
//   { ret: 200, data: { ip: "1.2.3.4", country: "中国", prov: "广东省",
//                       city: "深圳市", area: "南山区", isp: "电信" } }
import { describe, it, expect, vi, afterEach } from "vitest";
import { Ip9Provider } from "../../src/etl/providers/ip9";

afterEach(() => {
  vi.unstubAllGlobals();
});

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

describe("Ip9Provider", () => {
  it("maps a Chinese answer, keeping the district as the most specific field", async () => {
    stubFetch({
      body: {
        ret: 200,
        data: { ip: "1.2.3.4", country: "中国", prov: "广东省", city: "深圳市", area: "南山区", isp: "电信" },
      },
    });
    const out = await new Ip9Provider().lookup("1.2.3.4");
    expect(out.rateLimited).toBe(false);
    expect(out.record).toEqual({
      countryCode: "CN",
      countryName: "中国",
      region: "广东省",
      city: "南山区",
      latitude: null,
      longitude: null,
      timezone: null,
      isp: "电信",
      asn: null,
      asnOrg: null,
    });
  });

  it("falls back to the city when the district is absent", async () => {
    stubFetch({ body: { ret: 200, data: { country: "中国", prov: "北京市", city: "北京市" } } });
    const out = await new Ip9Provider().lookup("1.2.3.4");
    expect(out.record?.region).toBe("北京市");
    expect(out.record?.city).toBe("北京市");
  });

  it("maps overseas country names to their ISO codes", async () => {
    stubFetch({ body: { ret: 200, data: { country: "美国", prov: "加利福尼亚州", city: "洛杉矶" } } });
    const out = await new Ip9Provider().lookup("8.8.8.8");
    expect(out.record?.countryCode).toBe("US");
  });

  it("calls the documented endpoint over HTTPS", async () => {
    const fn = stubFetch({ body: { ret: 200, data: { country: "中国" } } });
    await new Ip9Provider().lookup("1.2.3.4");
    const url = String(fn.mock.calls[0]?.[0]);
    expect(url).toBe("https://ip9.com.cn/get?ip=1.2.3.4");
  });

  it("treats a body-level rate-limit signal as rateLimited", async () => {
    // The vendor answers 200 with ret !== 200 when it refuses. Reading
    // that as an ordinary abstention would hide the limit and keep the
    // backfill hammering it.
    stubFetch({ body: { ret: 429, msg: "访问过于频繁" } });
    const out = await new Ip9Provider().lookup("1.2.3.4");
    expect(out.rateLimited).toBe(true);
    expect(out.record).toBeNull();
  });

  it("flags an HTTP 429", async () => {
    stubFetch({ status: 429, body: {} });
    const out = await new Ip9Provider().lookup("1.2.3.4");
    expect(out.rateLimited).toBe(true);
  });

  it("abstains when the country cannot be resolved to a code", async () => {
    stubFetch({ body: { ret: 200, data: { country: "亚特兰蒂斯" } } });
    const out = await new Ip9Provider().lookup("1.2.3.4");
    expect(out.record).toBeNull();
    expect(out.errorCode).toBe("no_country");
  });

  it("treats a network failure as an abstention, not a crash", async () => {
    stubFetch({ throws: new Error("ECONNRESET") });
    const out = await new Ip9Provider().lookup("1.2.3.4");
    expect(out.record).toBeNull();
    expect(out.errorCode).toBe("network");
  });
});
