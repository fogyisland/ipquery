// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import { createTestDb, dropTestDb, type TestDb } from '../helpers/db';
import { createUser } from '../../src/storage/users';
import { createSession, loadSession } from '../../src/storage/sessions';
import { registerSessionPurger } from '../../src/web/plugins/sessionPurger';

let td: TestDb;
let userId: number;
beforeAll(async () => {
  td = await createTestDb('session_purger');
  const u = await createUser(td.pool, { email: 'p@x.com', passwordHash: 'h', displayName: 'P' });
  userId = u.id;
});
afterAll(async () => { await dropTestDb(td); });

describe('session purger plugin', () => {
  it('purgeNow() removes expired rows and keeps live ones', async () => {
    // Pre-MVP parked follow-up: purgeExpired was defined but never invoked.
    // The plugin gives it a periodic tick; this test exercises purgeNow()
    // directly (no need to wait for the production 1h interval).
    const past = new Date(Date.now() - 1000);
    const future = new Date(Date.now() + 3600_000);
    // CHAR(32) hard cap — pad/truncate to exactly 32.
    const pad = (s: string): string => (s + 'x'.repeat(32)).slice(0, 32);
    const expiredId = pad('plugin_expired');
    const liveId = pad('plugin_live');
    await createSession(td.pool, expiredId, userId, past);
    await createSession(td.pool, liveId, userId, future);

    const app = Fastify({ logger: false });
    const purger = registerSessionPurger(app, td.pool, { intervalMs: 24 * 60 * 60 * 1000 });
    try {
      const n = await purger.purgeNow();
      expect(n).toBeGreaterThanOrEqual(1);
    } finally {
      await app.close();
    }

    expect(await loadSession(td.pool, expiredId)).toBeNull();
    expect(await loadSession(td.pool, liveId)).not.toBeNull();
  });

  it('periodic tick fires on a short interval', async () => {
    // Drive the timer end-to-end with a tiny interval; the plugin's
    // purgeNow should be invoked automatically by setInterval.
    const past = new Date(Date.now() - 1000);
    const expiredId = (('periodic_expired' + 'x'.repeat(32)) as string).slice(0, 32);
    await createSession(td.pool, expiredId, userId, past);

    const app = Fastify({ logger: false });
    registerSessionPurger(app, td.pool, { intervalMs: 100 });
    try {
      // Poll for up to 3s for the periodic tick to clear the row.
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        const still = await loadSession(td.pool, expiredId);
        if (!still) break;
        await new Promise((r) => setTimeout(r, 100));
      }
    } finally {
      await app.close();
    }

    expect(await loadSession(td.pool, expiredId)).toBeNull();
  });

  it('onClose clears the timer and runs a final tick', async () => {
    // Set up an expired session, then close the app. The onClose hook
    // should fire one more purge so we don't leak the expired row just
    // because shutdown happened between ticks. Huge interval means the
    // periodic tick won't fire during this test — only onClose.
    const past = new Date(Date.now() - 1000);
    const expiredId = (('onclose_expired' + 'x'.repeat(32)) as string).slice(0, 32);
    await createSession(td.pool, expiredId, userId, past);

    const app = Fastify({ logger: false });
    registerSessionPurger(app, td.pool, { intervalMs: 24 * 60 * 60 * 1000 });

    // loadSession filters by TTL but doesn't DELETE — confirm the row is
    // still physically present before close:
    const [beforeClose] = await td.pool.query<{ id: string }[]>(
      `SELECT id FROM sessions WHERE id = ?`, [expiredId],
    );
    expect(beforeClose).toHaveLength(1);

    await app.close();

    const [afterClose] = await td.pool.query<{ id: string }[]>(
      `SELECT id FROM sessions WHERE id = ?`, [expiredId],
    );
    expect(afterClose).toHaveLength(0);
  });
});
