// SPDX-License-Identifier: MIT
//
// `admin_audit_log.target_id` is a BIGINT column, but callers audit two
// kinds of target: numeric row ids (user id, api key id) and human-readable
// names (an ingest provider name, an IP text).
//
// `Number("ip-api")` is NaN, and mysql2 renders NaN as the literal `NaN`,
// which MySQL rejects with ER_BAD_FIELD_ERROR ("Unknown column 'NaN' in
// 'field list'"). The audit write then fails — silently for the caller,
// because the audit hook only logs the error.
//
// So a non-numeric target must become NULL, and the readable value must
// survive somewhere: `metadata.target`.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { RowDataPacket } from "mysql2/promise";
import { createTestDb, dropTestDb, type TestDb } from "../helpers/db";
import { recordAuditLog } from "../../src/storage/auditLog";

let td: TestDb;

beforeAll(async () => {
  td = await createTestDb("auditTargetId");
});
afterAll(async () => {
  await dropTestDb(td);
});

interface AuditRow extends RowDataPacket {
  id: number;
  action: string;
  target_type: string | null;
  target_id: number | null;
  metadata: Record<string, unknown> | null;
}

async function lastAuditRow(): Promise<AuditRow> {
  const [rows] = await td.pool.query<AuditRow[]>(
    "SELECT id, action, target_type, target_id, metadata FROM admin_audit_log ORDER BY id DESC LIMIT 1",
  );
  return rows[0]!;
}

describe("recordAuditLog target_id normalisation", () => {
  it("stores a numeric target id as-is", async () => {
    await recordAuditLog(td.pool, {
      actor: { id: 1, email: "a@x.com" },
      action: "user.delete",
      targetType: "user",
      targetId: 42,
    });
    const row = await lastAuditRow();
    expect(row.target_id).toBe(42);
    expect(row.metadata).toBeNull();
  });

  it("stores a numeric string target id as a number", async () => {
    await recordAuditLog(td.pool, {
      actor: { id: 1, email: "a@x.com" },
      action: "key.revoke",
      targetType: "api_key",
      targetId: "7",
    });
    const row = await lastAuditRow();
    expect(row.target_id).toBe(7);
  });

  it("stores a non-numeric target as NULL instead of failing the insert", async () => {
    // This is the case that used to blow up: a provider name in a BIGINT
    // column. The insert must succeed.
    await recordAuditLog(td.pool, {
      actor: { id: 1, email: "a@x.com" },
      action: "unknown_ips.provider.update",
      targetType: "ingest_provider",
      targetId: "ip-api",
      metadata: { enabled: "on" },
    });
    const row = await lastAuditRow();
    expect(row.target_id).toBeNull();
    // The readable target survives in the metadata.
    expect(row.metadata).toMatchObject({ enabled: "on", target: "ip-api" });
  });

  it("keeps the readable target for an IP text", async () => {
    await recordAuditLog(td.pool, {
      actor: { id: 1, email: "a@x.com" },
      action: "unknown_ips.failure_logs.requeue",
      targetType: "unknown_ip_queue",
      targetId: "203.0.113.5",
    });
    const row = await lastAuditRow();
    expect(row.target_id).toBeNull();
    expect(row.metadata).toMatchObject({ target: "203.0.113.5" });
  });

  it("stores an absent target as NULL", async () => {
    await recordAuditLog(td.pool, {
      actor: { id: 1, email: "a@x.com" },
      action: "etl.trigger",
      targetType: "etl_run",
    });
    const row = await lastAuditRow();
    expect(row.target_id).toBeNull();
    expect(row.metadata).toBeNull();
  });

  it("does not overwrite a caller-supplied metadata.target for a numeric id", async () => {
    await recordAuditLog(td.pool, {
      actor: { id: 1, email: "a@x.com" },
      action: "user.delete",
      targetType: "user",
      targetId: 9,
      metadata: { target: "kept" },
    });
    const row = await lastAuditRow();
    expect(row.target_id).toBe(9);
    expect(row.metadata).toMatchObject({ target: "kept" });
  });
});
