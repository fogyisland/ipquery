// SPDX-License-Identifier: MIT
//
// Provider adapters for the unknown-IP backfill job. All adapters conform
// to IpGeoProvider and return a rich result so the backfill job can
// distinguish "no data" from "we asked too fast and got rate-limited".
//
// Country / region / city / ASN are best-effort strings. Providers don't
// agree on spelling ("United States" vs "USA", "CA" vs "California") —
// matching at consensus time is done on the canonical 2-letter country code
// and on normalized city/region lower-case equality. See majority.ts.

export interface IpGeoRecord {
  countryCode: string | null; // ISO 3166-1 alpha-2, e.g. "US"
  countryName: string | null; // "United States", "美国" — display only
  region: string | null; // "California", "CA"
  city: string | null; // "Mountain View"
  latitude: number | null;
  longitude: number | null;
  timezone: string | null;
  isp: string | null;
  asn: number | null; // AS15169 -> 15169
  asnOrg: string | null; // "Google LLC"
}

/** Per-call provider outcome. `rateLimited` is true iff the provider
 *  responded with HTTP 429 — the backfill job uses this to disable
 *  the provider on the spot instead of hammering it again next minute.
 *
 *  Optional `errorCode` and `rawResponse` are populated when the call
 *  failed in a way worth auditing (non-2xx HTTP, timeout, network).
 *  Used by the failure-log writer and circuit breaker. */
export interface IpGeoLookupResult {
  record: IpGeoRecord | null;
  rateLimited: boolean;
  errorCode?: string;
  rawResponse?: string | null;
}

export interface IpGeoProvider {
  /** Stable identifier — also the bucket name and the source tag in
   *  ip_ranges when this provider wins the vote. */
  readonly name: string;
  lookup(ip: string): Promise<IpGeoLookupResult>;
}
