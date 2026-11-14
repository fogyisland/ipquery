// SPDX-License-Identifier: MIT
//
// Optional demo data loader.
//
// The demo rows (50 hand-picked addresses: Google DNS, Cloudflare, the
// RFC 1918 ranges, …) used to be inserted by migration 012, which meant
// every database carried them whether the operator wanted them or not.
// A production install that skipped seeding still answered /lookup for
// 8.8.8.8, which reads as "populated" when the table holds nothing but
// demo addresses.
//
// They are now opt-in. This module is the single place that loads them,
// so the CLI command and the setup wizard cannot drift apart.
//
// The rows live in a .sql file rather than being written out in code:
// they are data, they were reviewed as SQL, and keeping them as SQL
// means the byte-order fix (16-byte right-aligned IPv4) stays visible
// to whoever reads them next.

import * as fs from "node:fs";
import * as path from "node:path";
import type { Pool, RowDataPacket } from "mysql2/promise";

/** The country_source value that marks every demo row. */
export const DEMO_SOURCE = "seed";

export interface DemoSeedResult {
  /** Rows in the table after loading. */
  total: number;
  /** Rows the load actually added. */
  added: number;
  /** True when the load was skipped because the table already held
   *  non-demo rows. `added` is 0 in that case. */
  skipped?: boolean;
  /** Why the load was skipped, for the caller to log. */
  skipReason?: string;
}

/** Locates the demo-ranges.sql file.
 *
 *  In the compiled tree it sits next to the migrations under
 *  dist/storage/seed/. In a tsx/tsx-dev run it sits under
 *  src/storage/seed/. Both are resolved so the command works in
 *  development and from the release bundle without a build step in
 *  between.
 */
export function findDemoSeedFile(): string | null {
  const candidates = [
    path.join(__dirname, "demo-ranges.sql"),
    path.join(__dirname, "..", "..", "src", "storage", "seed", "demo-ranges.sql"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/** Loads the demo rows into ip_ranges. Idempotent: the rows are inserted
 *  with INSERT IGNORE, backed by the uniq_seed UNIQUE index.
 *
 *  Does NOT run migrations — the caller decides when that happens. The
 *  setup wizard runs migrations before reaching the seed step, and the
 *  CLI command runs them itself; doing it here too would hide a
 *  migration failure behind a seed operation.
 */
export async function loadDemoSeed(pool: Pool): Promise<DemoSeedResult> {
  const seedFile = findDemoSeedFile();
  if (!seedFile) {
    throw new Error(
      "demo-ranges.sql not found — the build did not copy the seed file " +
        "(run `npm run build`, or check dist/storage/seed/)",
    );
  }
  const countDemoRows = async (): Promise<number> => {
    const [rows] = await pool.query<RowDataPacket[]>(
      "SELECT COUNT(*) AS n FROM ip_ranges WHERE country_source = ?",
      [DEMO_SOURCE],
    );
    return Number(rows[0]?.n ?? 0);
  };
  // Rows that did NOT come from this file — i.e. a real ETL import.
  const countRealRows = async (): Promise<number> => {
    const [rows] = await pool.query<RowDataPacket[]>(
      "SELECT COUNT(*) AS n FROM ip_ranges WHERE country_source IS NULL OR country_source <> ?",
      [DEMO_SOURCE],
    );
    return Number(rows[0]?.n ?? 0);
  };

  // The demo rows are only for an EMPTY database. INSERT IGNORE makes
  // re-running this idempotent for the demo rows themselves, but it says
  // nothing about a database that already holds real address data: the 50
  // demo rows do not collide with the ETL's ranges on uniq_start_end, so
  // they would be inserted alongside 8 million real rows. A lookup for
  // 8.8.8.8 would then answer from the demo row ("Mountain View") instead
  // of from the real library — the exact "populated but wrong" state this
  // module exists to prevent.
  //
  // So: if the table already holds rows that did not come from here, do
  // nothing and say why. Re-running `seed:demo`, `ipq init --seed` or the
  // wizard's demo step on a populated database is a no-op.
  const realRows = await countRealRows();
  if (realRows > 0) {
    return {
      total: await countDemoRows(),
      added: 0,
      skipped: true,
      skipReason:
        `ip_ranges already holds ${realRows} non-demo row(s); ` +
        "demo data is only loaded into an empty table",
    };
  }

  const before = await countDemoRows();
  await pool.query(fs.readFileSync(seedFile, "utf8"));
  const total = await countDemoRows();
  return { total, added: total - before };
}
