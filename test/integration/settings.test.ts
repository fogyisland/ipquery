// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb, dropTestDb, type TestDb } from '../helpers/db';
import {
  getSetting,
  setSetting,
  isInitialized,
  markInitialized,
} from '../../src/storage/settings';

let td: TestDb;
beforeAll(async () => { td = await createTestDb('settings'); });
afterAll(async () => { await dropTestDb(td); });

describe('settings storage', () => {
  it('getSetting returns null for missing key', async () => {
    expect(await getSetting(td.pool, 'missing_key')).toBeNull();
  });

  it('setSetting + getSetting round-trip', async () => {
    await setSetting(td.pool, 'greeting', 'hello');
    expect(await getSetting(td.pool, 'greeting')).toBe('hello');
  });

  it('setSetting UPSERT: setting twice returns the latest value', async () => {
    await setSetting(td.pool, 'theme', 'light');
    await setSetting(td.pool, 'theme', 'dark');
    expect(await getSetting(td.pool, 'theme')).toBe('dark');
  });

  it('isInitialized flips false → true after markInitialized', async () => {
    expect(await isInitialized(td.pool)).toBe(false);
    await markInitialized(td.pool);
    expect(await isInitialized(td.pool)).toBe(true);
  });

  it('markInitialized is idempotent', async () => {
    await markInitialized(td.pool);
    await expect(markInitialized(td.pool)).resolves.toBeUndefined();
    const v = await getSetting(td.pool, 'initialized_at');
    expect(v).not.toBeNull();
    expect(typeof v).toBe('string');
    // verify it parses as a valid ISO timestamp
    expect(Number.isNaN(Date.parse(v as string))).toBe(false);
  });
});
