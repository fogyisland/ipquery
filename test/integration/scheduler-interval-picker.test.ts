// SPDX-License-Identifier: MIT
//
// The interval picker must show the stored value as selected, whatever the
// stored value is.
//
// It did not: options were hardcoded to 30/60/300/900/1800 seconds while the
// shipped default is 180. Nothing matched, no option carried `selected`, and
// the browser submits the FIRST option — so opening the scheduler card and
// pressing save rewrote a three-minute cadence to thirty seconds. The page
// then showed the new value with no hint that anything had changed.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { createTestDb, dropTestDb, type TestDb } from "../helpers/db";
import { loadConfig } from "../../src/config";
import { buildServer } from "../../src/api/server";
import { createUser } from "../../src/storage/users";
import { createSession } from "../../src/storage/sessions";
import { generateToken } from "../../src/web/auth/tokens";
import { setSetting } from "../../src/storage/settings";
import { loadRandomGenConfig, RANDOM_GEN_INTERVAL_PRESETS } from "../../src/storage/randomProbeLog";

let td: TestDb;
let app: Awaited<ReturnType<typeof buildServer>>;
let adminSid: string;

beforeAll(async () => {
  td = await createTestDb("intervalpicker");
  const cfg = loadConfig();
  cfg.db.database = td.dbName;
  app = await buildServer(cfg);
  const admin = await createUser(app.pool, {
    email: "a@x.com",
    passwordHash: "h",
    displayName: "A",
    role: "admin",
  });
  adminSid = generateToken(16);
  await createSession(app.pool, adminSid, admin.id, new Date(Date.now() + 3600_000));
});

afterAll(async () => {
  await app.close();
  await dropTestDb(td);
});

/** The `<select name="intervalSec">` block, with its options. */
async function intervalSelect(): Promise<string> {
  const page = await request(app.server).get("/admin/ingest").set("Cookie", `sid=${adminSid}`);
  expect(page.status).toBe(200);
  return (page.text.match(/<select name="intervalSec">[\s\S]*?<\/select>/) ?? [""])[0];
}

describe("scheduler interval picker", () => {
  it("marks the shipped default (180s) as selected", async () => {
    await td.pool.query("DELETE FROM settings WHERE k = 'random_gen_interval_sec'");
    const config = await loadRandomGenConfig(app.pool);
    const block = await intervalSelect();

    expect(config.intervalSec).toBe(180);
    expect(block).toContain('value="180"');
    // The selected option must be the stored one, not merely present.
    const selected = block.match(/value="(\d+)"[^>]*selected/);
    expect(selected?.[1]).toBe("180");
  });

  it("marks a stored preset as selected", async () => {
    await setSetting(app.pool, "random_gen_interval_sec", "900");
    const block = await intervalSelect();
    expect(block.match(/value="(\d+)"[^>]*selected/)?.[1]).toBe("900");
  });

  it("keeps a stored value that is not a preset selectable", async () => {
    // An operator may have tuned the cadence to something outside the list.
    // Leaving that value out is what made a plain save overwrite it.
    await setSetting(app.pool, "random_gen_interval_sec", "240");
    const block = await intervalSelect();
    expect(block).toContain('value="240"');
    expect(block.match(/value="(\d+)"[^>]*selected/)?.[1]).toBe("240");
  });

  it("offers every preset", async () => {
    await td.pool.query("DELETE FROM settings WHERE k = 'random_gen_interval_sec'");
    const block = await intervalSelect();
    for (const preset of RANDOM_GEN_INTERVAL_PRESETS) {
      expect(block).toContain(`value="${preset}"`);
    }
  });

  it("labels the options instead of printing a dictionary key", async () => {
    const block = await intervalSelect();
    // A missing i18n key renders as its own name: "admin.unknownIps..."
    expect(block).not.toMatch(/admin\.unknownIps/);
    expect(block).toMatch(/\d+\s*(秒|分钟|小时)/);
  });
});
