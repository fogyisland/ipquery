// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestDb, dropTestDb, type TestDb } from "../helpers/db";
import { createUser } from "../../src/storage/users";
import { createVerification, findVerificationByHash, consumeVerification } from "../../src/storage/tokens";

let td: TestDb;
let userId: number;
beforeAll(async () => {
  td = await createTestDb("tokens");
  const u = await createUser(td.pool, { email: "v@x.com", passwordHash: "h", displayName: "V" });
  userId = u.id;
});
afterAll(async () => {
  await dropTestDb(td);
});

describe("email_verifications storage", () => {
  it("create + find round-trip", async () => {
    const future = new Date(Date.now() + 86_400_000);
    const v = await createVerification(td.pool, userId, "a".repeat(64), future);
    const found = await findVerificationByHash(td.pool, "a".repeat(64));
    expect(found?.id).toBe(v.id);
  });

  it("consume sets consumed_at", async () => {
    const future = new Date(Date.now() + 86_400_000);
    const v = await createVerification(td.pool, userId, "b".repeat(64), future);
    await consumeVerification(td.pool, v.id);
    const after = await findVerificationByHash(td.pool, "b".repeat(64));
    expect(after?.consumedAt).toBeInstanceOf(Date);
  });

  it("double-consume is no-op", async () => {
    const future = new Date(Date.now() + 86_400_000);
    const v = await createVerification(td.pool, userId, "c".repeat(64), future);
    await consumeVerification(td.pool, v.id);
    await consumeVerification(td.pool, v.id);
    const after = await findVerificationByHash(td.pool, "c".repeat(64));
    expect(after?.consumedAt).toBeInstanceOf(Date);
  });
});
