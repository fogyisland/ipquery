import type { EtlRunDownloadSource } from "../../storage/mysql";
import { type DedupeResult } from "./dedupe";
import { type ParseStats, type SourceRecord } from "./types";
import type { GithubStreamFile } from "./githubTypes";
export interface GithubPrepared {
    byFile: Map<EtlRunDownloadSource, ParseStats>;
    dedupe: DedupeResult;
}
export declare function materializeRecords(records: readonly SourceRecord[]): AsyncIterable<SourceRecord>;
export declare function prepareGithubSources(files: ReadonlyArray<GithubStreamFile>, rawDir: string): Promise<GithubPrepared>;
