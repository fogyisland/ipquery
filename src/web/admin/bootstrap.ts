// SPDX-License-Identifier: MIT
import type { Pool } from 'mysql2/promise';
import { hashPassword, validatePassword } from '../auth/password';
import { createUser, findUserByEmail } from '../../storage/users';

export interface BootstrapAdminOpts {
  email: string;
  password: string;
  displayName?: string;
}

export async function bootstrapAdmin(
  pool: Pool,
  opts: BootstrapAdminOpts,
): Promise<{ id: number }> {
  const v = validatePassword(opts.password);
  if (!v.ok) {
    const msg =
      v.reason === 'too_short'
        ? 'password must be at least 10 characters'
        : v.reason === 'no_letter'
          ? 'password must contain at least one letter'
          : 'password must contain at least one digit';
    throw new Error(msg);
  }

  const passwordHash = await hashPassword(opts.password);
  const displayName = opts.displayName ?? opts.email;

  const existing = await findUserByEmail(pool, opts.email);
  if (existing) {
    await pool.query(
      'UPDATE users SET password_hash = ?, role = ?, email_verified = 1 WHERE email = ?',
      [passwordHash, 'admin', opts.email],
    );
    return { id: existing.id };
  }

  const created = await createUser(pool, {
    email: opts.email,
    passwordHash,
    displayName,
    role: 'admin',
  });
  await pool.query('UPDATE users SET email_verified = 1 WHERE id = ?', [created.id]);
  return { id: created.id };
}
