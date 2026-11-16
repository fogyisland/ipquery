// SPDX-License-Identifier: MIT
//
// ip.sb provider. Free tier: 100 req/min with at most 5 req/s from a
// single source IP, no key, HTTPS only.
//
//   GET https://api.ip.sb/geoip/{ip}
//
// Why this one: the fan-out had shrunk to two providers, and a 2-of-N
// vote needs at least two non-abstaining answers — a single 429 was enough
// to make a round undecidable. ip.sb is a third voice, and it returns the
// ASN and organisation fields that ip-api and ipinfo do not both carry.
//
// Constraints worth remembering (they are the vendor's, not ours):
//   - 5 req/s burst limit. The backfill already serialises per-provider
//     calls, so the risk is low, but a future parallel fan-out must not
//     exceed it.
//   - Personal / non-commercial terms with no SLA. Fine for this backfill,
//     which is opportunistic and tolerates an abstention.
//   - English place names only, and no proxy/VPN/datacenter flag.
//
// On 429 we flag `rateLimited: true` so the backfill disables the provider
// instead of burning the next 100 calls per minute. Any other failure is an
// ordinary abstention with an errorCode for the audit log.

import type { IpGeoProvider, IpGeoLookupResult, IpGeoRecord } from "./types";

/** The subset of api.ip.sb/geoip's payload this adapter reads. */
interface IpSbPayload {
  ip?: string;
  country?: string;
  country_code?: string;
  region?: string;
  city?: string;
  latitude?: number;
  longitude?: number;
  timezone?: string;
  isp?: string;
  asn?: number;
  organization?: string;
  asn_organization?: string;
}

export class IpSbProvider implements IpGeoProvider {
  readonly name = "ip-sb";

  constructor(private readonly opts: { endpoint?: string; timeoutMs?: number } = {}) {}

  async lookup(ip: string): Promise<IpGeoLookupResult> {
    const base = this.opts.endpoint ?? "https://api.ip.sb";
    const url = `${base}/geoip/${encodeURIComponent(ip)}`;
    let res: Response;
    try {
      res = await fetch(url, {
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 5_000),
        // ip.sb is public and unauthenticated; identifying ourselves is
        // the polite thing for a service that asks not to be scraped.
        headers: { "User-Agent": "ipquery-backfill/1.0 (+https://ip.pudafo.com)" },
      });
    } catch (err) {
      return {
        record: null,
        rateLimited: false,
        errorCode: err instanceof Error && err.name === "TimeoutError" ? "timeout" : "network",
        rawResponse: err instanceof Error ? err.message : String(err),
      };
    }

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

    let payload: IpSbPayload;
    try {
      payload = (await res.json()) as IpSbPayload;
    } catch (err) {
      return {
        record: null,
        rateLimited: false,
        errorCode: "bad_json",
        rawResponse: err instanceof Error ? err.message : String(err),
      };
    }

    const countryCode = normalizeCountryCode(payload.country_code);
    if (!countryCode) {
      // Without a country there is nothing a consensus can use — the
      // gating field. Reporting a record with a null code would only make
      // the vote spend a slot on an empty answer.
      return { record: null, rateLimited: false, errorCode: "no_country", rawResponse: null };
    }

    const record: IpGeoRecord = {
      countryCode,
      countryName: clean(payload.country),
      region: clean(payload.region),
      city: clean(payload.city),
      latitude: numberOrNull(payload.latitude),
      longitude: numberOrNull(payload.longitude),
      timezone: clean(payload.timezone),
      isp: clean(payload.isp),
      asn: numberOrNull(payload.asn),
      // ip.sb spells the organisation two ways depending on the ASN
      // database it consulted; either is the same thing to us.
      asnOrg: clean(payload.asn_organization) ?? clean(payload.organization),
    };
    return { record, rateLimited: false };
  }
}

/** Trim, and treat an empty string as absent. */
function clean(value: string | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/** A finite number, or null — JSON can carry `null` or a string. */
function numberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/** Uppercase a two-letter ISO code; anything else is not a country code. */
function normalizeCountryCode(value: string | undefined): string | null {
  const cleaned = clean(value);
  if (!cleaned) return null;
  const upper = cleaned.toUpperCase();
  return /^[A-Z]{2}$/.test(upper) ? upper : null;
}

/** Read a response body for the audit log without letting a read failure
 *  turn into a lookup failure. */
async function safeBody(res: Response): Promise<string | null> {
  try {
    const text = await res.text();
    return text.length > 512 ? `${text.slice(0, 512)}…` : text;
  } catch {
    return null;
  }
}
