// SPDX-License-Identifier: MIT
//
// ipinfo.io provider. Free tier: 50k req/month with a registered token.
// Response shape:
//
//   { ip: "8.8.8.8", city: "Mountain View", region: "California",
//     country: "US", loc: "37.3860,-122.0838", org: "AS15169 Google LLC",
//     postal: "94035", timezone: "America/Los_Angeles" }
//
// ipinfo doesn't split ASN number and org — they're combined in `org`.
// 401 (no/bad token) -> record=null, NOT rateLimited (won't recover).
// 429 -> record=null, rateLimited=true (backfill disables us).

import type { IpGeoProvider, IpGeoLookupResult } from "./types";

export class IpinfoProvider implements IpGeoProvider {
  readonly name = "ipinfo";

  constructor(private readonly opts: { token?: string; endpoint?: string } = {}) {}

  async lookup(ip: string): Promise<IpGeoLookupResult> {
    if (!this.opts.token) return { record: null, rateLimited: false }; // token missing -> abstain
    const url = `${this.opts.endpoint ?? "https://ipinfo.io"}/${encodeURIComponent(ip)}/json?token=${encodeURIComponent(this.opts.token)}`;
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
      const data = (await res.json()) as {
        city?: string;
        region?: string;
        country?: string;
        loc?: string; // "lat,lon"
        org?: string; // "AS15169 Google LLC"
        timezone?: string;
      };
      const [lat, lon] = parseLoc(data.loc ?? null);
      const asn = parseAsn(data.org ?? null);
      return {
        record: {
          countryCode: data.country ?? null,
          countryName: null, // ipinfo only sends the code
          region: data.region ?? null,
          city: data.city ?? null,
          latitude: lat,
          longitude: lon,
          timezone: data.timezone ?? null,
          isp: null, // ipinfo collapses ISP into `org`
          asn,
          asnOrg: extractOrgFromOrg(data.org ?? null),
        },
        rateLimited: false,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const code = msg.includes("timeout") || msg.includes("aborted") ? "timeout" : "network";
      return { record: null, rateLimited: false, errorCode: code, rawResponse: msg.slice(0, 240) };
    }
  }
}

async function safeBody(res: Response): Promise<string | null> {
  try {
    const text = await res.text();
    return text.length > 240 ? text.slice(0, 240) : text;
  } catch {
    return null;
  }
}

function parseLoc(raw: string | null): [number | null, number | null] {
  if (!raw) return [null, null];
  const [a, b] = raw.split(",");
  const lat = a == null ? null : Number(a);
  const lon = b == null ? null : Number(b);
  return [Number.isFinite(lat) ? (lat as number) : null, Number.isFinite(lon) ? (lon as number) : null];
}

function parseAsn(raw: string | null): number | null {
  if (!raw) return null;
  const m = raw.match(/(?:AS)?(\d+)/i);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function extractOrgFromOrg(raw: string | null): string | null {
  if (!raw) return null;
  const trimmed = raw.replace(/^\s*AS\d+\s*/i, "").trim();
  return trimmed.length > 0 ? trimmed : null;
}
