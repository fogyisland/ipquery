// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { hashPassword, verifyPassword, validatePassword } from "../../src/web/auth/password";

describe("password", () => {
  it("hash + verify round-trip", async () => {
    const hash = await hashPassword("Hello123World");
    expect(hash).toMatch(/^\$argon2id\$/);
    expect(await verifyPassword(hash, "Hello123World")).toBe(true);
    expect(await verifyPassword(hash, "WrongPassword1")).toBe(false);
  });

  it("different hash each call", async () => {
    const a = await hashPassword("Hello123World");
    const b = await hashPassword("Hello123World");
    expect(a).not.toBe(b);
  });

  it("validatePassword enforces length", () => {
    expect(validatePassword("Short1")).toEqual({ ok: false, reason: "too_short" });
    expect(validatePassword("NoDigitsHere!!")).toEqual({ ok: false, reason: "no_digit" });
    expect(validatePassword("1234567890")).toEqual({ ok: false, reason: "no_letter" });
    expect(validatePassword("GoodPassword1")).toEqual({ ok: true });
  });

  it("handles verify of malformed hash gracefully", async () => {
    expect(await verifyPassword("not-a-hash", "whatever")).toBe(false);
  });
});
