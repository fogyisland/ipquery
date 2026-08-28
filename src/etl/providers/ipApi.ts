// SPDX-License-Identifier: MIT
//
// ip-api.com provider. Free tier: 45 req/min from a single source IP, no
// key. Response shape:
//
//   { status: "success", country: "United States", countryCode: "US",
//     region: "CA", regionName: "California", city: "Mountain View",
//     lat: 37.4192, lon: -122.0574, timezone: "America/Los_Angeles",
//     isp: "Google LLC", org: "Google LLC", as: "AS15169 Google LLC" }
//
// On rate-limit (429) or `status: "fail"` we return null — the bucket's
// backoff will slow subsequent calls and the backfill job retries next
// time.

import type { IpGeoProvider, IpGeoRecord } from './types';

export class IpApiProvider implements IpGeoProvider {
  readonly name = 'ip-api';

  constructor(private readonly opts: { endpoint?: string } = {}) {}

  async lookup(ip: string): Promise<IpGeoRecord | null> {
    const url = `${this.opts.endpoint ?? 'http://ip-api.com'}/json/${encodeURIComponent(ip)}?fields=status,country,countryCode,region,regionName,city,lat,lon,timezone,isp,org,as,query`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
      if (!res.ok) return null;
      const data = await res.json() as {
        status?: string;
        country?: string;
        countryCode?: string;
        region?: string;
        regionName?: string;
        city?: string;
        lat?: number;
        lon?: number;
        timezone?: string;
        isp?: string;
        org?: string;
        as?: string;
      };
      if (data.status !== 'success') return null;
      return {
        countryCode: data.countryCode ?? null,
        countryName: data.country ?? null,
        region: data.regionName ?? null,
        city: data.city ?? null,
        latitude: typeof data.lat === 'number' ? data.lat : null,
        longitude: typeof data.lon === 'number' ? data.lon : null,
        timezone: data.timezone ?? null,
        isp: data.isp ?? null,
        asn: parseAsn(data.as ?? null),
        asnOrg: extractOrgFromAs(data.as ?? null) ?? data.org ?? null,
      };
    } catch {
      return null;
    }
  }
}

/** "AS15169 Google LLC" -> 15169. Tolerates whitespace, "AS"-prefix or
 *  bare numbers. */
function parseAsn(raw: string | null): number | null {
  if (!raw) return null;
  const m = raw.match(/(?:AS)?(\d+)/i);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** "AS15169 Google LLC" -> "Google LLC". Falls back to whole string if
 *  the leading "ASxxxxx" pattern isn't there. */
function extractOrgFromAs(raw: string | null): string | null {
  if (!raw) return null;
  const trimmed = raw.replace(/^\s*AS\d+\s*/i, '').trim();
  return trimmed.length > 0 ? trimmed : null;
}