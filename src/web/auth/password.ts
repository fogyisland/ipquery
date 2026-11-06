// SPDX-License-Identifier: MIT
import * as argon2 from "argon2";

const ARGON_OPTS = {
  type: argon2.argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const;

export async function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, ARGON_OPTS);
}

export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plain);
  } catch {
    return false;
  }
}

export type PasswordValidation = { ok: true } | { ok: false; reason: "too_short" | "no_digit" | "no_letter" };

export function validatePassword(plain: string): PasswordValidation {
  if (plain.length < 10) return { ok: false, reason: "too_short" };
  if (!/[a-zA-Z]/.test(plain)) return { ok: false, reason: "no_letter" };
  if (!/[0-9]/.test(plain)) return { ok: false, reason: "no_digit" };
  return { ok: true };
}
