import type { IpGeoRecord } from "./providers/types";
export type ConsensusField = keyof Pick<IpGeoRecord, "countryCode" | "countryName" | "region" | "city" | "latitude" | "longitude" | "timezone" | "isp" | "asn" | "asnOrg">;
export type ConsensusResult = {
    ok: true;
    record: IpGeoRecord;
    /** For diagnostics: how many providers contributed per field. */
    agreement: Partial<Record<ConsensusField, number>>;
} | {
    ok: false;
    reason: "no_consensus" | "no_country" | "all_abstained";
    /** Per-provider contribution summary for debugging. */
    perProvider: Record<string, IpGeoRecord | null>;
};
/** Run majority-vote on responses from the providers that actually
 *  returned a record (null = abstained). The caller passes ALL responses
 *  including nulls so we can report per-provider abstention. */
export declare function majorityVote(responses: Array<{
    provider: string;
    record: IpGeoRecord | null;
}>): ConsensusResult;
