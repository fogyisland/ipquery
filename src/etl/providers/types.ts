// SPDX-License-Identifier: MIT
//
// Provider adapters for the unknown-IP backfill job. All adapters conform
// to IpGeoProvider and return null on hard failure (network error, 4xx/5xx
// response, or unparseable JSON) — never throw. The backfill job treats
// null as "this provider abstained" and the majority-vote logic falls back
// on the others.
//
// Country / region / city / ASN are best-effort strings. Providers don't
// agree on spelling ("United States" vs "USA", "CA" vs "California") —
// matching at consensus time is done on the canonical 2-letter country code
// and on normalized city/region lower-case equality. See majority.ts.

export interface IpGeoRecord {
  countryCode: string | null;   // ISO 3166-1 alpha-2, e.g. "US"
  countryName: string | null;   // "United States", "美国" — display only
  region: string | null;        // "California", "CA"
  city: string | null;          // "Mountain View"
  latitude: number | null;
  longitude: number | null;
  timezone: string | null;
  isp: string | null;
  asn: number | null;           // AS15169 -> 15169
  asnOrg: string | null;        // "Google LLC"
}

export interface IpGeoProvider {
  /** Stable identifier — also the bucket name and the source tag in
   *  ip_ranges when this provider wins the vote. */
  readonly name: string;
  lookup(ip: string): Promise<IpGeoRecord | null>;
}