// SPDX-License-Identifier: MIT
import * as mysql from 'mysql2/promise';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { AppConfig } from '../config';
import type { IpRangeRow, EtlRun, Source } from '../types';

let SCHEMA_SQL: string | null = null;
async function loadSchema(): Promise<string> {
  if (SCHEMA_SQL) return SCHEMA_SQL;
  const p = path.join(__dirname, 'schema.sql');
  SCHEMA_SQL = await fs.readFile(p, 'utf8');
  return SCHEMA_SQL;
}

export function createPool(cfg: AppConfig): mysql.Pool {
  return mysql.createPool({
    host: cfg.db.host,
    port: cfg.db.port,
    user: cfg.db.user,
    password: cfg.db.password,
    database: cfg.db.database,
    connectionLimit: cfg.db.poolSize,
    waitForConnections: true,
    multipleStatements: true,
    timezone: 'Z',
    dateStrings: false,
  });
}

export async function initSchema(pool: mysql.Pool): Promise<void> {
  const sql = await loadSchema();
  await pool.query(sql);
}

export async function truncateNew(pool: mysql.Pool): Promise<void> {
  await pool.query('TRUNCATE TABLE ip_ranges_new');
}

export async function insertIntoNew(pool: mysql.Pool, rows: IpRangeRow[]): Promise<void> {
  if (rows.length === 0) return;
  const CHUNK = 1000;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK);
    const values: unknown[] = [];
    const placeholders = slice.map((r) => {
      values.push(
        r.startIp, r.endIp,
        r.countryCode ?? null, r.countryName ?? null,
        r.region ?? null, r.city ?? null, r.postalCode ?? null,
        r.latitude ?? null, r.longitude ?? null, r.timezone ?? null,
        r.isp ?? null, r.asn ?? null, r.asnOrg ?? null,
        r.countrySource ?? null, r.citySource ?? null,
        r.ispSource ?? null, r.asnSource ?? null, r.geoSource ?? null,
      );
      return '(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)';
    }).join(',');
    await pool.query(
      `INSERT INTO ip_ranges_new (start_ip,end_ip,country_code,country_name,region,city,postal_code,latitude,longitude,timezone,isp,asn,asn_org,country_source,city_source,isp_source,asn_source,geo_source) VALUES ${placeholders}`,
      values,
    );
  }
}

export async function atomicSwapRanges(pool: mysql.Pool): Promise<void> {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query('RENAME TABLE ip_ranges TO ip_ranges_old, ip_ranges_new TO ip_ranges, ip_ranges_old TO ip_ranges_new');
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

export async function findRange(pool: mysql.Pool, ipBuf: Buffer): Promise<IpRangeRow | null> {
  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    `SELECT start_ip, end_ip, country_code, country_name, region, city, postal_code,
            latitude, longitude, timezone, isp, asn, asn_org,
            country_source, city_source, isp_source, asn_source, geo_source
       FROM ip_ranges
       WHERE start_ip <= ? AND end_ip >= ?
       ORDER BY (end_ip - start_ip) ASC
       LIMIT 1`,
    [ipBuf, ipBuf],
  );
  if (rows.length === 0) return null;
  const r = rows[0]!;
  return {
    startIp: r.start_ip as Buffer,
    endIp: r.end_ip as Buffer,
    countryCode: r.country_code, countryName: r.country_name,
    region: r.region, city: r.city, postalCode: r.postal_code,
    latitude: r.latitude == null ? undefined : Number(r.latitude),
    longitude: r.longitude == null ? undefined : Number(r.longitude),
    timezone: r.timezone, isp: r.isp,
    asn: r.asn == null ? undefined : Number(r.asn),
    asnOrg: r.asn_org,
    countrySource: r.country_source as Source | undefined,
    citySource: r.city_source as Source | undefined,
    ispSource: r.isp_source as Source | undefined,
    asnSource: r.asn_source as Source | undefined,
    geoSource: r.geo_source as Source | undefined,
  };
}

export async function recordEtlStart(pool: mysql.Pool): Promise<number> {
  const [res] = await pool.query<mysql.ResultSetHeader>(
    `INSERT INTO etl_runs (started_at, status) VALUES (NOW(3), 'running')`,
  );
  return res.insertId;
}

export async function recordEtlFinish(
  pool: mysql.Pool, id: number, status: 'success' | 'failed', fields: Partial<EtlRun>,
): Promise<void> {
  const set: string[] = ['finished_at = NOW(3)', 'status = ?'];
  const values: unknown[] = [status];
  if (fields.maxmindRecords !== undefined) { set.push('maxmind_records = ?'); values.push(fields.maxmindRecords); }
  if (fields.ip2regionRecords !== undefined) { set.push('ip2region_records = ?'); values.push(fields.ip2regionRecords); }
  if (fields.dbipRecords !== undefined) { set.push('dbip_records = ?'); values.push(fields.dbipRecords); }
  if (fields.mergedRecords !== undefined) { set.push('merged_records = ?'); values.push(fields.mergedRecords); }
  if (fields.errorMessage !== undefined) { set.push('error_message = ?'); values.push(fields.errorMessage); }
  if (fields.maxmindBuiltAt !== undefined) { set.push('maxmind_built_at = ?'); values.push(fields.maxmindBuiltAt); }
  if (fields.ip2regionBuiltAt !== undefined) { set.push('ip2region_built_at = ?'); values.push(fields.ip2regionBuiltAt); }
  if (fields.dbipBuiltAt !== undefined) { set.push('dbip_built_at = ?'); values.push(fields.dbipBuiltAt); }
  values.push(id);
  await pool.query(`UPDATE etl_runs SET ${set.join(', ')} WHERE id = ?`, values);
}

export async function lastEtlRun(pool: mysql.Pool): Promise<EtlRun | null> {
  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    `SELECT * FROM etl_runs ORDER BY id DESC LIMIT 1`,
  );
  if (rows.length === 0) return null;
  const r = rows[0]!;
  return {
    id: Number(r.id), startedAt: r.started_at, finishedAt: r.finished_at,
    status: r.status,
    maxmindRecords: r.maxmind_records, ip2regionRecords: r.ip2region_records,
    dbipRecords: r.dbip_records, mergedRecords: r.merged_records,
    errorMessage: r.error_message,
    maxmindBuiltAt: r.maxmind_built_at, ip2regionBuiltAt: r.ip2region_built_at,
    dbipBuiltAt: r.dbip_built_at,
  };
}
