import { type CidrRange, type ParseStreamResult, type SourceRecord } from "./types";
export declare function parseCidrLine(line: string): CidrRange | null;
export declare function parseMetowolfCidrStreamWithStats(filePath: string): ParseStreamResult<SourceRecord>;
export declare function parseRunishiwoV4CidrStreamWithStats(filePath: string): ParseStreamResult<SourceRecord>;
export declare function parseRunishiwoV6CidrStreamWithStats(filePath: string): ParseStreamResult<SourceRecord>;
