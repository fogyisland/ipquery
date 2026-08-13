// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb, dropTestDb, type TestDb } from '../helpers/db';
import { createUser } from '../../src/storage/users';
import { createSession, loadSession, destroySession, destroyAllForUser, purgeExpired } from '../../src/storage/sessions';

let td: TestDb;
let userId: number;
beforeAll(async () => {
  td = await createTestDb('sessions');
  const u = await createUser(td.pool, { email: 's@x.com', passwordHash: 'h', displayName: 'S' });
  userId = u.id;
});
afterAll(async () => { await dropTestDb(td); });

describe('sessions storage', () => {
  it('create + load round-trip', async () => {
    const future = new Date(Date.now() + 3600_000);
    const s = await createSession(td.pool, 'abcdefghijklmnopqrstuvwxyz012345', userId, future);
    expect(s.id).toHaveLength(32);
    const loaded = await loadSession(td.pool, s.id);
    expect(loaded?.userId).toBe(userId);
  });

  it('expired session not loaded', async () => {
    const past = new Date(Date.now() - 1000);
    await createSession(td.pool, 'expired_session_id_with_32_chars', userId, past);
    expect(await loadSession(td.pool, 'expired_session_id_with_32_chars')).toBeNull();
  });

  it('destroySession removes row', async () => {
    const future = new Date(Date.now() + 3600_000);
    await createSession(td.pool, 'will_be_destroyed_session_id_xxx', userId, future);
    await destroySession(td.pool, 'will_be_destroyed_session_id_xxx');
    expect(await loadSession(td.pool, 'will_be_destroyed_session_id_xxx')).toBeNull();
  });

  it('destroyAllForUser removes all', async () => {
    const future = new Date(Date.now() + 3600_000);
    await createSession(td.pool, 'first_session_id_with_32_chars_a', userId, future);
    await createSession(td.pool, 'second_session_id_with_32_chars_', userId, future);
    await destroyAllForUser(td.pool, userId);
    expect(await loadSession(td.pool, 'first_session_id_with_32_chars_a')).toBeNull();
    expect(await loadSession(td.pool, 'second_session_id_with_32_chars_')).toBeNull();
  });

  it('purgeExpired removes past', async () => {
    const past = new Date(Date.now() - 1000);
    await createSession(td.pool, 'will_be_purged_session_id_xxxxxx', userId, past);
    const n = await purgeExpired(td.pool);
    expect(n).toBeGreaterThanOrEqual(1);
    expect(await loadSession(td.pool, 'will_be_purged_session_id_xxxxxx')).toBeNull();
  });
});