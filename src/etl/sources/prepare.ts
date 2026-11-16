// SPDX-License-Identifier: MIT
import * as path from "node:path";
import type { EtlRunDownloadSource } from "../../storage/mysql";
import { dedupeSourceRecords, type DedupeResult } from "./dedupe";
import {
  newStats,
  type ParseStats,
  type SourceRecord,
} from "./types";
import type { GithubStreamFile } from "./githubTypes";

export interface GithubPrepared {
  byFile: Map<EtlRunDownloadSource, ParseStats>;
  dedupe: DedupeResult;
}

export async function* materializeRecords(
  records: readonly SourceRecord[],
): AsyncIterable<SourceRecord> {
  yield* records;
}

export async function prepareGithubSources(
  files: ReadonlyArray<GithubStreamFile>,
  rawDir: string,
): Promise<GithubPrepared> {
  const byFile = new Map<EtlRunDownloadSource, ParseStats>();
  const inputs: SourceRecord[] = [];
  for (const file of files) {
    const { records, stats } = file.parse(path.join(rawDir, file.filename));
    byFile.set(file.etlSource, stats);
    for await (const record of records) inputs.push(record);
  }
  const dedupe = await dedupeSourceRecords(materializeRecords(inputs));
  for (const [etlSource, stats] of byFile) {
    byFile.set(etlSource, {
      ...stats,
      rowsEmitted: dedupe.stats.emittedByFile[etlSource] ?? 0,
      gunzipErrors: 0,
    });
  }
  return { byFile, dedupe };
}
