import type { NormalizedRecord } from "../../types";
/**
 * v1: parses JSON-export form of ip2region. Future work: replace with
 * a real binary .xdb reader per https://gitee.com/lionsoul/ip2region
 */
export declare function parseIp2regionXdb(xdbPath: string): Promise<NormalizedRecord[]>;
