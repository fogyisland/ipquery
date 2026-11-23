// SPDX-License-Identifier: MIT
// Probe: (re)create a signed-in user for the account-menu walk.
//
// Each run starts from a known state — the walk changes the nickname
// and the password, so the password has to be reset before the next
// run. Credentials come from .env via dotenv — never on a command line.
import * as dotenv from "dotenv";
import * as mysql from "mysql2/promise";
import { hashPassword } from "../../src/web/auth/password";
import { createUser } from "../../src/storage/users";
import { createSession } from "../../src/storage/sessions";
import { generateToken } from "../../src/web/auth/tokens";

dotenv.config({ path: ".env" });

async function main(): Promise<void> {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST ?? "localhost",
    port: Number(process.env.DB_PORT ?? 3306),
    user: process.env.DB_USER ?? "root",
    password: process.env.DB_PASSWORD ?? "",
    database: process.env.DB_NAME ?? "ipquery",
  });

  const email = "menu-probe@x.com";
  const displayName = process.env.PROBE_NAME ?? "张三";
  const password = process.env.PROBE_PASSWORD ?? "MenuProbe1";

  await conn.query(`DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE email = ?)`, [
    email,
  ]);
  await conn.query(`DELETE FROM users WHERE email = ?`, [email]);

  const pool = conn as unknown as mysql.Pool;
  const u = await createUser(pool, {
    email,
    passwordHash: await hashPassword(password),
    displayName,
  });
  const sid = generateToken(16);
  await createSession(pool, sid, u.id, new Date(Date.now() + 3600_000));

  console.log(`SID=${sid}`);
  console.log(`EMAIL=${email}`);
  console.log(`PASSWORD=${password}`);
  await conn.end();
}

void main().catch((err: unknown) => {
  console.error("probe failed:", err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
