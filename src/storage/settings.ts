// SPDX-License-Identifier: MIT
import type { Pool, ResultSetHeader, RowDataPacket } from "mysql2/promise";

export async function getSetting(pool: Pool, key: string): Promise<string | null> {
  const [rows] = await pool.query<RowDataPacket[]>(`SELECT v FROM settings WHERE k = ?`, [key]);
  const r = rows[0] as { v: string } | undefined;
  return r ? r.v : null;
}

export async function setSetting(pool: Pool, key: string, value: string): Promise<void> {
  await pool.query<ResultSetHeader>(
    `INSERT INTO settings (k, v) VALUES (?, ?)
     ON DUPLICATE KEY UPDATE v = VALUES(v)`,
    [key, value],
  );
}

export async function isInitialized(pool: Pool): Promise<boolean> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT 1 FROM settings WHERE k = 'initialized_at' LIMIT 1`,
  );
  return rows.length > 0;
}

export async function markInitialized(pool: Pool): Promise<void> {
  await setSetting(pool, "initialized_at", new Date().toISOString());
}
