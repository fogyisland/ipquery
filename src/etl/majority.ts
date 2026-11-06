// SPDX-License-Identifier: MIT
//
// 2-of-3 majority vote across provider responses for a single IP.
//
// Rules:
// - For each field we look at the non-null values across providers.
// - If at least 2 providers agree, the agreed value wins.
// - Fields where providers disagree (1-1-1, or 2-1 split with the lone
//   dissenter) get dropped (set to null in the merged record) — better
//   to write NULL than to write something wrong.
// - Country code is REQUIRED to merge at all. If we can't get a 2/3
//   agreement on country code, the whole row is treated as no_consensus
//   and the queue row stays pending for a future attempt.

import type { IpGeoRecord } from "./providers/types";

export type ConsensusField = keyof Pick<
  IpGeoRecord,
  | "countryCode"
  | "countryName"
  | "region"
  | "city"
  | "latitude"
  | "longitude"
  | "timezone"
  | "isp"
  | "asn"
  | "asnOrg"
>;

export type ConsensusResult =
  | {
      ok: true;
      record: IpGeoRecord;
      /** For diagnostics: how many providers contributed per field. */
      agreement: Partial<Record<ConsensusField, number>>;
    }
  | {
      ok: false;
      reason: "no_consensus" | "no_country" | "all_abstained";
      /** Per-provider contribution summary for debugging. */
      perProvider: Record<string, IpGeoRecord | null>;
    };

const FIELDS: ConsensusField[] = [
  "countryCode",
  "countryName",
  "region",
  "city",
  "latitude",
  "longitude",
  "timezone",
  "isp",
  "asn",
  "asnOrg",
];

/** Run majority-vote on responses from the providers that actually
 *  returned a record (null = abstained). The caller passes ALL responses
 *  including nulls so we can report per-provider abstention. */
export function majorityVote(
  responses: Array<{ provider: string; record: IpGeoRecord | null }>,
): ConsensusResult {
  const valid = responses.filter((r): r is { provider: string; record: IpGeoRecord } => r.record !== null);

  if (valid.length === 0) {
    return {
      ok: false,
      reason: "all_abstained",
      perProvider: Object.fromEntries(responses.map((r) => [r.provider, r.record])),
    };
  }

  // Country code is the gating field — without 2/3 agreement we can't
  // merge. Many providers return only the code (ipinfo), some return both
  // code + name (ip-api, iplocate); the latter is fine.
  const countryCodeVotes = valid
    .map((r) => r.record.countryCode)
    .filter((c): c is string => typeof c === "string" && c.length > 0);

  if (countryCodeVotes.length < 2) {
    // 0-1 votes -> either all abstained (already handled above) or only
    // one provider had a code and the others abstained or sent null.
    // Treat as no_country.
    return {
      ok: false,
      reason: "no_country",
      perProvider: Object.fromEntries(responses.map((r) => [r.provider, r.record])),
    };
  }

  const countryWinner = pickMajority(countryCodeVotes);
  if (!countryWinner) {
    return {
      ok: false,
      reason: "no_consensus",
      perProvider: Object.fromEntries(responses.map((r) => [r.provider, r.record])),
    };
  }

  // For everything else, accept whatever 2+ providers agree on; if no
  // 2-of-3 agreement, drop the field (write NULL).
  const merged: IpGeoRecord = {
    countryCode: countryWinner.value,
    countryName: null,
    region: null,
    city: null,
    latitude: null,
    longitude: null,
    timezone: null,
    isp: null,
    asn: null,
    asnOrg: null,
  };
  const agreement: Partial<Record<ConsensusField, number>> = { countryCode: countryWinner.count };

  for (const field of FIELDS) {
    if (field === "countryCode") continue; // already handled
    const values = valid
      .map((r) => r.record[field])
      .filter(
        (v): v is NonNullable<IpGeoRecord[ConsensusField]> => v !== null && v !== undefined && v !== "",
      );
    const pick = pickMajority(values);
    if (pick) {
      (merged[field] as unknown) = pick.value;
      agreement[field] = pick.count;
    }
  }

  return { ok: true, record: merged, agreement };
}

function pickMajority<T>(values: T[]): { value: T; count: number } | null {
  if (values.length === 0) return null;
  const counts = new Map<T, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best: { value: T; count: number } | null = null;
  for (const [value, count] of counts) {
    if (count >= 2 && (!best || count > best.count)) {
      best = { value, count };
    }
  }
  return best;
}
