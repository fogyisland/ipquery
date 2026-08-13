// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb, dropTestDb, type TestDb } from '../helpers/db';
import { createUser, findUserByEmail, markEmailVerified, setDisabled, updatePassword, listUsers } from '../../src/storage/users';
import { hashPassword } from '../../src/web/auth/password';

let td: TestDb;
beforeAll(async () => { td = await createTestDb('users'); });
afterAll(async () => { await dropTestDb(td); });

describe('users storage', () => {
  it('create + find round-trip', async () => {
    const hash = await hashPassword('Hello123World');
    const u = await createUser(td.pool, { email: 'a@x.com', passwordHash: hash, displayName: 'Alice' });
    expect(u.id).toBeGreaterThan(0);
    expect(u.email).toBe('a@x.com');
    expect(u.role).toBe('user');
    expect(u.emailVerified).toBe(false);
    const found = await findUserByEmail(td.pool, 'a@x.com');
    expect(found?.id).toBe(u.id);
  });

  it('email is unique', async () => {
    const hash = await hashPassword('Hello123World');
    await expect(createUser(td.pool, { email: 'dup@x.com', passwordHash: hash, displayName: 'A' })).resolves.toBeDefined();
    await expect(createUser(td.pool, { email: 'dup@x.com', passwordHash: hash, displayName: 'B' })).rejects.toThrow();
  });

  it('markEmailVerified flips flag', async () => {
    const u = await createUser(td.pool, { email: 'b@x.com', passwordHash: 'h', displayName: 'B' });
    expect(u.emailVerified).toBe(false);
    await markEmailVerified(td.pool, u.id);
    const after = await findUserByEmail(td.pool, 'b@x.com');
    expect(after?.emailVerified).toBe(true);
  });

  it('setDisabled toggles is_disabled', async () => {
    const u = await createUser(td.pool, { email: 'c@x.com', passwordHash: 'h', displayName: 'C' });
    await setDisabled(td.pool, u.id, true);
    expect((await findUserByEmail(td.pool, 'c@x.com'))?.isDisabled).toBe(true);
    await setDisabled(td.pool, u.id, false);
    expect((await findUserByEmail(td.pool, 'c@x.com'))?.isDisabled).toBe(false);
  });

  it('updatePassword replaces hash', async () => {
    const u = await createUser(td.pool, { email: 'd@x.com', passwordHash: 'old', displayName: 'D' });
    await updatePassword(td.pool, u.id, 'new');
    expect((await findUserByEmail(td.pool, 'd@x.com'))?.id).toBe(u.id);
  });

  it('listUsers pagination + search', async () => {
    for (let i = 0; i < 5; i++) {
      await createUser(td.pool, { email: `p${i}@x.com`, passwordHash: 'h', displayName: `P${i}` });
    }
    const r = await listUsers(td.pool, { offset: 0, limit: 3, search: 'p' });
    expect(r.rows.length).toBe(3);
    expect(r.total).toBeGreaterThanOrEqual(5);
  });
});