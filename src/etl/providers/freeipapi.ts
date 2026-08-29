// SPDX-License-Identifier: MIT
//
// freeipapi.com provider. Free tier: 60 req/min, no key, HTTPS.
//
// Endpoint:
//   GET https://freeipapi.com/api/json/{ip}
//
// Response shape (the parts we use):
//   { ipAddress, countryCode, countryName, cityName, regionName,
//     latitude, longitude, timeZone, isp, organization, asn }
//
// 429 -> rateLimited=true. Other 4xx/5xx, timeout, or malformed JSON ->
// record=null, rateLimited=false. Never throw; backfill treats null as
// "abstain".

import type { IpGeoProvider, IpGeoLookupResult } from './types';

export class FreeIpApiProvider implements IpGeoProvider {
  readonly name = 'freeipapi';

  constructor(private readonly opts: { endpoint?: string } = {}) {}

  async lookup(ip: string): Promise<IpGeoLookupResult> {
    const url = `${this.opts.endpoint ?? 'https://freeipapi.com'}/api/json/${encodeURIComponent(ip)}`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
      if (res.status === 429) {
        return { record: null, rateLimited: true, errorCode: '429', rawResponse: await safeBody(res) };
      }
      if (!res.ok) {
        return { record: null, rateLimited: false, errorCode: String(res.status), rawResponse: await safeBody(res) };
      }
      const data = await res.json() as {
        countryCode?: string;
        countryName?: string;
        cityName?: string;
        regionName?: string;
        latitude?: number;
        longitude?: number;
        timeZone?: string;
        isp?: string;
        organization?: string;
        asn?: number | string;
      };
      if (!data.countryCode) {
        return { record: null, rateLimited: false, errorCode: 'no_country' };
      }
      return {
        record: {
          countryCode: data.countryCode,
          countryName: data.countryName ?? null,
          region: data.regionName ?? null,
          city: data.cityName ?? null,
          latitude: typeof data.latitude === 'number' ? data.latitude : null,
          longitude: typeof data.longitude === 'number' ? data.longitude : null,
          timezone: data.timeZone ?? null,
          isp: data.isp ?? null,
          asn: typeof data.asn === 'number' ? data.asn : (typeof data.asn === 'string' ? Number(data.asn) : null),
          asnOrg: data.organization ?? null,
        },
        rateLimited: false,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const code = msg.includes('timeout') || msg.includes('aborted') ? 'timeout' : 'network';
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
