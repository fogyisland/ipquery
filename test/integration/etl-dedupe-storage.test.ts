// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as mysql from "mysql2/promise";
import { createTestDb, dropTestDb, type TestDb } from "../helpers/db";
import {
  getEtlRunDedupe,
  insertEtlRunDedupe,
  insertEtlRunDownload,
  recordEtlStart,
  type EtlRunDownloadSource,
} from "../../src/storage/mysql";

let testDb: TestDb;
let pool: mysql.Pool;

const NEW_SOURCES: EtlRunDownloadSource[] = [
  "dbip-city",
  "dbip-country",
  "dbip-asn",
  "metowolf-cn",
  "runishiwo-cn",
  "runishiwo-v6",
  "sapics-user",
];

beforeAll(async () => {
  testDb = await createTestDb("etl-dedupe-storage");
  pool = testDb.pool;
});

afterAll(async () => {
  await dropTestDb(testDb);
});

describe("etl_run_dedupe storage", () => {
  it("persists every source label and round-trips dedupe totals", async () => {
    const [tables] = await pool.query<mysql.RowDataPacket[]>("SHOW TABLES");
    const tableNames = tables.map((row) => Object.values(row)[0] as string);
    expect(tableNames).toContain("etl_run_dedupe");

    const [columns] = await pool.query<mysql.RowDataPacket[]>(
      `SELECT TABLE_NAME, COLUMN_TYPE
         FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME IN ('etl_run_downloads', 'etl_run_parses', 'etl_run_inserts')
          AND COLUMN_NAME = 'source'`,
    );
    expect(columns).toHaveLength(3);
    for (const column of columns) {
      const columnType = String(column.COLUMN_TYPE);
      for (const source of NEW_SOURCES) {
        expect(columnType).toContain(source);
      }
    }

    const runId = await recordEtlStart(pool);
    for (const source of NEW_SOURCES) {
      await insertEtlRunDownload(pool, {
        runId,
        source,
        destName: `${source}.fixture`,
        sourceUrl: null,
        month: null,
        status: "success",
        bytes: 1,
        durationMs: 1,
        retryCount: 0,
        errorMessage: null,
        startedAt: new Date(),
        finishedAt: new Date(),
      });
    }

    const startedAt = new Date("2026-11-15T02:00:00.000Z");
    const finishedAt = new Date("2026-11-15T02:00:00.012Z");
    await insertEtlRunDedupe(pool, {
      runId,
      inputRows: 10,
      contained: 2,
      exactDuplicates: 1,
      partialOverlaps: 1,
      emitted: 6,
      durationMs: 12,
      startedAt,
      finishedAt,
    });

    expect(await getEtlRunDedupe(pool, runId)).toEqual({
      runId,
      inputRows: 10,
      contained: 2,
      exactDuplicates: 1,
      partialOverlaps: 1,
      emitted: 6,
      durationMs: 12,
      startedAt: new Date("2026-11-15T02:00:00.000Z"),
      finishedAt: new Date("2026-11-15T02:00:00.012Z"),
    });
    expect(await getEtlRunDedupe(pool, runId + 987_654)).toBeNull();
  });
});

// Type-only assignment: the compiler must reject unknown labels while
// accepting every label the migration's ENUM admits.
const _acceptedSources: EtlRunDownloadSource[] = NEW_SOURCES;
void _acceptedSources;
// @ts-expect-error unknown labels are not part of the side-table contract.
const _rejectedSource: EtlRunDownloadSource = "unknown-source";
void _rejectedSource;
