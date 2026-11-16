import type { ParseStreamResult } from "./types";
import type { SourceRecord } from "./types";
import type { IpRangeRow } from "../../types";
import type { EtlRunDownloadSource } from "../../storage/mysql";
import type { Source } from "../../types";
export interface StreamFile {
    source: Source;
    etlSource: EtlRunDownloadSource;
    filename: string;
    validate: "gzip" | "text";
    textFormat?: "cidr" | "country-csv";
    parse: (p: string) => ParseStreamResult;
    fillCols: ReadonlySet<keyof IpRangeRow>;
    dedupeGroup?: "github-list";
}
export interface GithubStreamFile extends Omit<StreamFile, "parse"> {
    parse: (p: string) => ParseStreamResult<SourceRecord>;
}
export declare function isGithubStreamFile(file: StreamFile): file is GithubStreamFile;
