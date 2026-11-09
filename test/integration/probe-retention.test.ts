// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import Fastify from "fastify";
import { createTestDb, dropTestDb, type TestDb } from "../helpers/db";
import { registerProbeRetention } from "../../src/web/plugins/probeRetention";
import { setSetting } from "../../src/storage/settings";
import { parseIp } from "../../src/ip";

let td: TestDb;

beforeAll(async () => {
  td = await createTestDb("probe_retention");
});
afterAll(async () => {
  await dropTestDb(td);
});

beforeEach(async () => {
  await td.pool.query("TRUNCATE TABLE random_probe_log");
  await td.pool.query("DELETE FROM settings WHERE k = 'random_probe_retention_days'");
});

/** Insert a probe row with an explicit timestamp (daysAgo 0 = now). */
async function insertProbe(daysAgo: number, batchId: string): Promise<void> {
  const ip = "203.0.113.30";
  await td.pool.query(
    `INSERT INTO random_probe_log
       (ip_text, ip_binary, mode, outcome, consensus_country, consensus_city,
        consensus_asn, merged_run_id, providers_json, batch_id, ts)
     VALUES (?, ?, 'auto', 'merged', 'US', 'X', 1, NULL, '[]', ?,
             FROM_UNIXTIME(? / 1000))`,
    [ip, parseIp(ip)!, batchId, Date.now() - daysAgo * 24 * 60 * 60 * 1000],
  );
}

describe("probe retention plugin", () => {
  it("purgeNow() removes rows past the window and keeps recent ones", async () => {
    await insertProbe(40, "old");
    await insertProbe(2, "recent");

    const app = Fastify({ logger: false });
    const retention = registerProbeRetention(app, td.pool, {
      intervalMs: 24 * 60 * 60 * 1000,
    });
    try {
      const purged = await retention.purgeNow();
      expect(purged).toBe(1);
    } finally {
      await app.close();
    }

    const [rows] = await td.pool.query<{ batch_id: string }[]>(`SELECT batch_id FROM random_probe_log`);
    expect(rows).toHaveLength(1);
    expect(rows[0].batch_id).toBe("recent");
  });

  it("periodic tick fires on a short interval", async () => {
    await insertProbe(40, "periodic_old");

    const app = Fastify({ logger: false });
    registerProbeRetention(app, td.pool, { intervalMs: 100 });
    try {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const [rows] = await td.pool.query<{ id: number }[]>(
          `SELECT id FROM random_probe_log WHERE batch_id = 'periodic_old'`,
        );
        if (rows.length === 0) break;
        await new Promise((r) => setTimeout(r, 100));
      }
    } finally {
      await app.close();
    }

    const [rows] = await td.pool.query<{ id: number }[]>(
      `SELECT id FROM random_probe_log WHERE batch_id = 'periodic_old'`,
    );
    expect(rows).toHaveLength(0);
  });

  it("onClose stops the timer without touching the pool", async () => {
    await insertProbe(40, "onclose_old");

    const app = Fastify({ logger: false });
    registerProbeRetention(app, td.pool, { intervalMs: 24 * 60 * 60 * 1000 });

    const [beforeClose] = await td.pool.query<{ id: number }[]>(
      `SELECT id FROM random_probe_log WHERE batch_id = 'onclose_old'`,
    );
    expect(beforeClose).toHaveLength(1);

    // No final sweep on close. In production the pool is closed by an
    // onClose hook registered earlier, so Fastify runs that one first
    // and a final sweep here would only log "Pool is closed". The rows
    // are audit data — the next sweep removes them.
    await app.close();

    const [afterClose] = await td.pool.query<{ id: number }[]>(
      `SELECT id FROM random_probe_log WHERE batch_id = 'onclose_old'`,
    );
    expect(afterClose).toHaveLength(1);
  });

  it("honors the configured retention window", async () => {
    await setSetting(td.pool, "random_probe_retention_days", "7");
    await insertProbe(10, "ten_days_old");
    await insertProbe(3, "three_days_old");

    const app = Fastify({ logger: false });
    const retention = registerProbeRetention(app, td.pool, {
      intervalMs: 24 * 60 * 60 * 1000,
    });
    try {
      const purged = await retention.purgeNow();
      expect(purged).toBe(1);
    } finally {
      await app.close();
    }

    const [rows] = await td.pool.query<{ batch_id: string }[]>(`SELECT batch_id FROM random_probe_log`);
    expect(rows).toHaveLength(1);
    expect(rows[0].batch_id).toBe("three_days_old");
  });

  it("keeps everything when retention is disabled (0)", async () => {
    await setSetting(td.pool, "random_probe_retention_days", "0");
    await insertProbe(400, "ancient");

    const app = Fastify({ logger: false });
    const retention = registerProbeRetention(app, td.pool, {
      intervalMs: 24 * 60 * 60 * 1000,
    });
    try {
      const purged = await retention.purgeNow();
      expect(purged).toBe(0);
    } finally {
      await app.close();
    }

    const [rows] = await td.pool.query<{ id: number }[]>(`SELECT id FROM random_probe_log`);
    expect(rows).toHaveLength(1);
  });
});
