import type { NormalizedRecord } from "../../types";
/**
 * Extract every IP range from the .mmdb by probing a sparse set of IPs.
 * Approach: walk known subnets (configurable density) and detect range
 * boundaries by querying consecutive IPs.
 *
 * For production scale we use maxmind's open iterator over the mmdb tree;
 * here we keep a simpler implementation that works with the public API.
 */
export declare function parseMaxmindMmdb(mmdbPath: string, edition: "city" | "asn"): Promise<NormalizedRecord[]>;
