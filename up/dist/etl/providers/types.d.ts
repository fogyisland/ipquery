export interface IpGeoRecord {
    countryCode: string | null;
    countryName: string | null;
    region: string | null;
    city: string | null;
    latitude: number | null;
    longitude: number | null;
    timezone: string | null;
    isp: string | null;
    asn: number | null;
    asnOrg: string | null;
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
