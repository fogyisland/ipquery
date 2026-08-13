// SPDX-License-Identifier: MIT
import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import type { Session } from '../types';

function mapRow(r: RowDataPacket): Session {
  return {
    id: r.id as string,
    userId: Number(r.user_id),
    expiresAt: r.expires_at as Date,
    createdAt: r.created_at as Date,
  };
}

export async function createSession(pool: Pool, id: string, userId: number, expiresAt: Date): Promise<Session> {
  await pool.query<ResultSetHeader>(
    `INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)`,
    [id, userId, expiresAt],
  );
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT * FROM sessions WHERE id = ?`, [id],
  );
  if (!rows[0]) throw new Error('session vanished');
  return mapRow(rows[0]);
}

export async function loadSession(pool: Pool, id: string): Promise<Session | null> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT * FROM sessions WHERE id = ? AND expires_at > UTC_TIMESTAMP(3)`, [id],
  );
  return rows[0] ? mapRow(rows[0]) : null;
}

export async function destroySession(pool: Pool, id: string): Promise<void> {
  await pool.query(`DELETE FROM sessions WHERE id = ?`, [id]);
}

export async function destroyAllForUser(pool: Pool, userId: number): Promise<void> {
  await pool.query(`DELETE FROM sessions WHERE user_id = ?`, [userId]);
}

export async function purgeExpired(pool: Pool): Promise<number> {
  const [res] = await pool.query<ResultSetHeader>(`DELETE FROM sessions WHERE expires_at <= UTC_TIMESTAMP(3)`);
  return res.affectedRows;
}
