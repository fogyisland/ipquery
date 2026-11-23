// SPDX-License-Identifier: MIT
//
// The migration ledger is keyed by the numeric prefix of the file name:
// `036_server_clock_timestamps.sql` is recorded as "036". That makes the
// prefix a version identifier, and version identifiers are unique.
//
// Nothing enforced that. Two files with the same prefix collided, and
// the symptom was MySQL's `Duplicate entry '035' for key 'PRIMARY'` —
// thrown from inside the runner's ledger insert, naming neither of the
// two files that caused it.
//
// The silent variant is the dangerous one. On a database that had already
// applied "035", the runner sees "035" in the ledger, skips BOTH files,
// and never runs the second one at all. A migration that never runs is
// worse than one that fails loudly: the data is left in the old shape
// and nothing says so.
//
// These tests pin the loud behaviour, and pin that it happens before the
// runner touches the database — a build defect must not apply half the
// step list before it is noticed.
import { describe, it, expect, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type * as mysql from "mysql2/promise";
import {
  runMigrations,
  loadMigrationManifestFrom,
  reloadMigrationManifest,
} from "../../src/storage/migrations/runner";

/** A manifest directory holding the given `name -> sql` files. */
function manifestDir(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipq-migrations-"));
  for (const [name, sql] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), sql, "utf8");
  }
  return dir;
}

/** A pool that records whether it was used at all. */
function poolRecordingUse(): { pool: mysql.Pool; used: () => boolean } {
  let used = false;
  const conn = {
    beginTransaction: vi.fn().mockResolvedValue(undefined),
    query: vi.fn().mockResolvedValue([[], []]),
    commit: vi.fn().mockResolvedValue(undefined),
    rollback: vi.fn().mockResolvedValue(undefined),
    release: vi.fn(),
  };
  const pool = {
    query: vi.fn().mockImplementation(async () => {
      used = true;
      return [[], []];
    }),
    getConnection: vi.fn().mockImplementation(async () => {
      used = true;
      return conn;
    }),
  };
  return { pool: pool as unknown as mysql.Pool, used: () => used };
}

afterEach(async () => {
  // Put the real manifest back for whatever runs next in this file.
  await reloadMigrationManifest();
});

describe("a migration version collision", () => {
  it("is refused, naming the version and both files", async () => {
    const dir = manifestDir({
      "035_first.sql": "SELECT 1;",
      "035_second.sql": "SELECT 2;",
    });
    await loadMigrationManifestFrom(dir);

    const { pool } = poolRecordingUse();
    const err = await runMigrations(pool).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    expect(message).toMatch(/035/);
    expect(message).toMatch(/035_first\.sql/);
    expect(message).toMatch(/035_second\.sql/);
  });

  it("is refused before the database is touched", async () => {
    // The step list is not a sequence of independent steps: a migration
    // can depend on the one before it. Applying half the list and then
    // failing leaves the database in a state no build describes.
    const dir = manifestDir({
      "035_first.sql": "SELECT 1;",
      "035_second.sql": "SELECT 2;",
    });
    await loadMigrationManifestFrom(dir);

    const { pool, used } = poolRecordingUse();
    await runMigrations(pool).catch(() => undefined);

    expect(used()).toBe(false);
  });

  it("does not fire on a manifest whose prefixes are all distinct", async () => {
    const dir = manifestDir({
      "001_alpha.sql": "SELECT 1;",
      "002_beta.sql": "SELECT 2;",
    });
    await loadMigrationManifestFrom(dir);

    const { pool } = poolRecordingUse();
    const result = await runMigrations(pool);

    expect(result.applied).toEqual(["001", "002"]);
  });

  it("does not fire on a manifest that ships no migrations at all", async () => {
    const dir = manifestDir({});
    await loadMigrationManifestFrom(dir);

    const { pool } = poolRecordingUse();
    const result = await runMigrations(pool);

    expect(result.applied).toEqual([]);
  });
});
