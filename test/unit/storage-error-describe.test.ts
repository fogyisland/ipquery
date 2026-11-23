// SPDX-License-Identifier: MIT
//
// A metadata-lock timeout is not an internal fault.
//
// When the IP range table is held by another session, the read gives up
// after METADATA_LOCK_WAIT_SECONDS instead of waiting for the server's
// one-year default. The caller then gets an error — and the question
// this file answers is what that error LOOKS like.
//
// It must be a 503, not a 500:
//
//   - 500 means "we are broken". The client's request was fine.
//   - 503 means "we are up, but the dependency we need is not
//     available right now, come back later". That is exactly the
//     situation, and it is what a client should retry on.
//
// A client that cannot tell the two apart has to guess: a 500 invites
// an alert, a 503 invites a retry. Guessing wrong turns a ten-second
// dependency stall into a page.
//
// The message matters too. The operator reading the log needs to know
// that a METADATA lock was the cause and that the fix is to release the
// holder — not to look at row-level contention.
import { describe, it, expect } from "vitest";
import { describeStorageError } from "../../src/storage/mysql";

describe("describeStorageError", () => {
  it("turns a MySQL metadata-lock timeout into a 503 the client can retry", () => {
    const driverError = Object.assign(new Error("Lock wait timeout exceeded; try restarting transaction"), {
      code: "ER_LOCK_WAIT_TIMEOUT",
      errno: 1205,
    });

    const described = describeStorageError(driverError) as Error & {
      statusCode?: number;
      code?: string;
    };

    expect(described.statusCode).toBe(503);
    expect(described.code).toBe("service_unavailable");
  });

  it("names the metadata lock in the message", () => {
    const driverError = Object.assign(new Error("Lock wait timeout exceeded; try restarting transaction"), {
      code: "ER_LOCK_WAIT_TIMEOUT",
    });

    const described = describeStorageError(driverError);
    expect(described.message).toMatch(/metadata lock/i);
  });

  it("points the operator at the tool that finds the holder", () => {
    const driverError = Object.assign(new Error("Lock wait timeout exceeded"), {
      code: "ER_LOCK_WAIT_TIMEOUT",
    });

    const described = describeStorageError(driverError);
    expect(described.message).toContain("probe-lock-queue.ts");
  });

  it("keeps the driver's original message so the log keeps the detail", () => {
    const driverError = Object.assign(new Error("Lock wait timeout exceeded; try restarting transaction"), {
      code: "ER_LOCK_WAIT_TIMEOUT",
    });

    const described = describeStorageError(driverError);
    expect(described.message).toContain("Lock wait timeout exceeded");
  });

  it("recognises the timeout by errno when there is no driver code", () => {
    const driverError = Object.assign(new Error("Lock wait timeout exceeded"), { errno: 1205 });
    const described = describeStorageError(driverError) as Error & { statusCode?: number };
    expect(described.statusCode).toBe(503);
  });

  it("leaves an unrelated database error alone", () => {
    // A SQL typo must not be reported as a lock problem. It is a
    // different bug with a different fix, and mislabelling it would
    // send the operator to the wrong place entirely.
    const driverError = Object.assign(new Error("ER_PARSE_ERROR: syntax near 'SELECT * FROM secret'"), {
      code: "ER_PARSE_ERROR",
      errno: 1064,
    });

    const described = describeStorageError(driverError);
    expect(described).toBe(driverError);
    expect(described.message).not.toMatch(/metadata lock/i);
  });

  it("leaves a plain error alone", () => {
    const plain = new Error("boom");
    expect(describeStorageError(plain)).toBe(plain);
  });

  it("does not mistake an unrelated error that merely mentions a lock for a timeout", () => {
    // "Lock wait timeout" is the specific signal. An error that mentions
    // locking in another way must not be dressed up as a timeout.
    const other = Object.assign(new Error("ER_LOCK_DEADLOCK: Deadlock found when trying to get lock"), {
      code: "ER_LOCK_DEADLOCK",
      errno: 1213,
    });
    expect(describeStorageError(other)).toBe(other);
  });
});
