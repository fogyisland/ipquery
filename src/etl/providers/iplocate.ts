// SPDX-License-Identifier: MIT
//
// iplocate.io provider. Free tier: 1k req/day with a registered key.
// Response shape:
//
//   { ip: "8.8.8.8", country_code: "US", country_name: "United States",
//     city: "Mountain View", region: "California", latitude: 37.386,
//     longitude: -122.0838, asn: "15169", asn_org: "Google LLC",
//     isp: "Google LLC", timezone: "America/Los_Angeles", is_eu: false }
//
// iplocate splits ASN (number) and ASN org cleanly. 401/403 -> null; the
// bucket throttles but doesn't help here — we just abstain and the vote
// falls back on the other providers.

import type { IpGeoProvider, IpGeoRecord } from './types';

export class IplocateProvider implements IpGeoProvider {
  readonly name = 'iplocate';

  constructor(private readonly opts: { apiKey?: string; endpoint?: string } = {}) {}

  async lookup(ip: string): Promise<IpGeoRecord | null> {
    if (!this.opts.apiKey) return null; // key missing -> abstain
    const url = `${this.opts.endpoint ?? 'https://www.iplocate.io'}/api/v2/lookup/${encodeURIComponent(ip)}`;
    try {
      const res = await fetch(url, {
        headers: { 'x-api-key': this.opts.apiKey },
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) return null;
      const data = await res.json() as {
        country_code?: string;
        country_name?: string;
        city?: string;
        region?: string;
        latitude?: number;
        longitude?: number;
        timezone?: string;
        isp?: string;
        asn?: string | number;
        asn_org?: string;
      };
      return {
        countryCode: data.country_code ?? null,
        countryName: data.country_name ?? null,
        region: data.region ?? null,
        city: data.city ?? null,
        latitude: typeof data.latitude === 'number' ? data.latitude : null,
        longitude: typeof data.longitude === 'number' ? data.longitude : null,
        timezone: data.timezone ?? null,
        isp: data.isp ?? null,
        asn: typeof data.asn === 'number' ? data.asn : (typeof data.asn === 'string' ? Number(data.asn) : null),
        asnOrg: data.asn_org ?? null,
      };
    } catch {
      return null;
    }
  }
}