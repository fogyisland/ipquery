// SPDX-License-Identifier: MIT
import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import type { User, Role } from '../types';

export interface CreateUserInput {
  email: string;
  passwordHash: string;
  displayName: string;
  role?: Role;
}

function mapRow(r: RowDataPacket): User {
  return {
    id: Number(r.id),
    email: r.email as string,
    displayName: r.display_name as string,
    role: r.role as Role,
    emailVerified: Boolean(r.email_verified),
    isDisabled: Boolean(r.is_disabled),
    createdAt: r.created_at as Date,
    lastLoginAt: r.last_login_at as Date | null,
  };
}

export async function createUser(pool: Pool, input: CreateUserInput): Promise<User> {
  const [res] = await pool.query<ResultSetHeader>(
    `INSERT INTO users (email, password_hash, display_name, role) VALUES (?, ?, ?, ?)`,
    [input.email, input.passwordHash, input.displayName, input.role ?? 'user'],
  );
  const u = await findUserById(pool, res.insertId);
  if (!u) throw new Error('user vanished after insert');
  return u;
}

export async function findUserByEmail(pool: Pool, email: string): Promise<User | null> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT * FROM users WHERE email = ?`, [email],
  );
  return rows[0] ? mapRow(rows[0]) : null;
}

export async function findUserById(pool: Pool, id: number): Promise<User | null> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT * FROM users WHERE id = ?`, [id],
  );
  return rows[0] ? mapRow(rows[0]) : null;
}

export async function getUserPasswordHash(pool: Pool, userId: number): Promise<string | null> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT password_hash FROM users WHERE id = ?`, [userId],
  );
  return rows[0] ? (rows[0].password_hash as string) : null;
}

export async function markEmailVerified(pool: Pool, userId: number): Promise<void> {
  await pool.query(`UPDATE users SET email_verified = 1 WHERE id = ?`, [userId]);
}

export async function setDisabled(pool: Pool, userId: number, disabled: boolean): Promise<void> {
  await pool.query(`UPDATE users SET is_disabled = ? WHERE id = ?`, [disabled ? 1 : 0, userId]);
}

export async function updatePassword(pool: Pool, userId: number, newHash: string): Promise<void> {
  await pool.query(`UPDATE users SET password_hash = ? WHERE id = ?`, [newHash, userId]);
}

export async function updateDisplayName(pool: Pool, userId: number, name: string): Promise<void> {
  await pool.query(`UPDATE users SET display_name = ? WHERE id = ?`, [name, userId]);
}

export async function updateEmail(pool: Pool, userId: number, email: string): Promise<void> {
  await pool.query(`UPDATE users SET email = ?, email_verified = 0 WHERE id = ?`, [email, userId]);
}

export async function setLastLogin(pool: Pool, userId: number): Promise<void> {
  await pool.query(`UPDATE users SET last_login_at = NOW(3) WHERE id = ?`, [userId]);
}

export async function deleteUser(pool: Pool, userId: number): Promise<void> {
  await pool.query(`DELETE FROM users WHERE id = ?`, [userId]);
}

export async function listUsers(pool: Pool, opts: {
  offset: number; limit: number; search?: string; role?: Role;
}): Promise<{ rows: User[]; total: number }> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.search) { where.push('email LIKE ?'); params.push(`%${opts.search}%`); }
  if (opts.role) { where.push('role = ?'); params.push(opts.role); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT * FROM users ${whereSql} ORDER BY id DESC LIMIT ? OFFSET ?`,
    [...params, opts.limit, opts.offset],
  );
  const [totalRows] = await pool.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS c FROM users ${whereSql}`, params,
  );
  return {
    rows: rows.map(mapRow),
    total: Number((totalRows[0] as { c: number }).c),
  };
}