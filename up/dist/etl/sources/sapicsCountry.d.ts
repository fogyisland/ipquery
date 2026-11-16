import { type CidrRange, type ParseStreamResult, type SourceRecord } from "./types";
export declare function parseSapicsCountryCsvLine(line: string): CidrRange | null;
export declare function parseSapicsCountryStreamWithStats(filePath: string): ParseStreamResult<SourceRecord>;
