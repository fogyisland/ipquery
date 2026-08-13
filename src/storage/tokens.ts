// SPDX-License-Identifier: MIT
import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import type { EmailVerification, PasswordReset } from '../types';

function mapVerRow(r: RowDataPacket): EmailVerification {
  return {
    id: Number(r.id),
    userId: Number(r.user_id),
    tokenHash: r.token_hash as string,
    expiresAt: r.expires_at as Date,
    consumedAt: r.consumed_at as Date | null,
    createdAt: r.created_at as Date,
  };
}

function mapResRow(r: RowDataPacket): PasswordReset {
  return {
    id: Number(r.id),
    userId: Number(r.user_id),
    tokenHash: r.token_hash as string,
    expiresAt: r.expires_at as Date,
    consumedAt: r.consumed_at as Date | null,
  };
}

export async function createVerification(pool: Pool, userId: number, tokenHash: string, expiresAt: Date): Promise<EmailVerification> {
  const [res] = await pool.query<ResultSetHeader>(
    `INSERT INTO email_verifications (user_id, token_hash, expires_at) VALUES (?, ?, ?)`,
    [userId, tokenHash, expiresAt],
  );
  const v = await findVerificationById(pool, res.insertId);
  if (!v) throw new Error('verification vanished');
  return v;
}

export async function findVerificationByHash(pool: Pool, tokenHash: string): Promise<EmailVerification | null> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT * FROM email_verifications WHERE token_hash = ?`, [tokenHash],
  );
  return rows[0] ? mapVerRow(rows[0]) : null;
}

export async function findVerificationById(pool: Pool, id: number): Promise<EmailVerification | null> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT * FROM email_verifications WHERE id = ?`, [id],
  );
  return rows[0] ? mapVerRow(rows[0]) : null;
}

export async function consumeVerification(pool: Pool, id: number): Promise<void> {
  await pool.query(
    `UPDATE email_verifications SET consumed_at = NOW(3) WHERE id = ? AND consumed_at IS NULL`,
    [id],
  );
}

export async function lastVerificationForUser(pool: Pool, userId: number): Promise<EmailVerification | null> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT * FROM email_verifications WHERE user_id = ? ORDER BY id DESC LIMIT 1`,
    [userId],
  );
  return rows[0] ? mapVerRow(rows[0]) : null;
}

export async function createPasswordReset(pool: Pool, userId: number, tokenHash: string, expiresAt: Date): Promise<PasswordReset> {
  const [res] = await pool.query<ResultSetHeader>(
    `INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES (?, ?, ?)`,
    [userId, tokenHash, expiresAt],
  );
  const v = await findPasswordResetById(pool, res.insertId);
  if (!v) throw new Error('reset vanished');
  return v;
}

export async function findPasswordResetByHash(pool: Pool, tokenHash: string): Promise<PasswordReset | null> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT * FROM password_resets WHERE token_hash = ?`, [tokenHash],
  );
  return rows[0] ? mapResRow(rows[0]) : null;
}

export async function findPasswordResetById(pool: Pool, id: number): Promise<PasswordReset | null> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT * FROM password_resets WHERE id = ?`, [id],
  );
  return rows[0] ? mapResRow(rows[0]) : null;
}

export async function consumePasswordReset(pool: Pool, id: number): Promise<void> {
  await pool.query(
    `UPDATE password_resets SET consumed_at = NOW(3) WHERE id = ? AND consumed_at IS NULL`,
    [id],
  );
}
