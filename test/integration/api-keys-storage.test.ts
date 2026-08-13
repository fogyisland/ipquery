// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb, dropTestDb, type TestDb } from '../helpers/db';
import { createUser } from '../../src/storage/users';
import { createApiKey, findActiveApiKeyByHash, revokeApiKey, listApiKeysForUser } from '../../src/storage/apiKeys';
import { generateApiKey, hashToken } from '../../src/web/auth/tokens';

let td: TestDb;
let userId: number;
beforeAll(async () => {
  td = await createTestDb('apikeys');
  const u = await createUser(td.pool, { email: 'a@x.com', passwordHash: 'h', displayName: 'A' });
  userId = u.id;
});
afterAll(async () => { await dropTestDb(td); });

describe('api_keys storage', () => {
  it('create + findActive round-trip', async () => {
    const plaintext = generateApiKey();
    const key = await createApiKey(td.pool, userId, 'lbl', hashToken(plaintext), plaintext.slice(0, 8));
    expect(key.label).toBe('lbl');
    expect(key.keyPrefix).toBe(plaintext.slice(0, 8));
    const found = await findActiveApiKeyByHash(td.pool, hashToken(plaintext));
    expect(found?.id).toBe(key.id);
  });

  it('revoked key not found active', async () => {
    const plaintext = generateApiKey();
    const key = await createApiKey(td.pool, userId, 'rev', hashToken(plaintext), plaintext.slice(0, 8));
    await revokeApiKey(td.pool, key.id);
    expect(await findActiveApiKeyByHash(td.pool, hashToken(plaintext))).toBeNull();
  });

  it('listApiKeysForUser returns all keys', async () => {
    const keys = await listApiKeysForUser(td.pool, userId);
    expect(keys.length).toBeGreaterThanOrEqual(2);
  });

  it('key_hash is unique', async () => {
    const hash = hashToken(generateApiKey());
    await createApiKey(td.pool, userId, 'k1', hash, 'ipq_xxxx');
    await expect(createApiKey(td.pool, userId, 'k2', hash, 'ipq_yyyy')).rejects.toThrow();
  });
});