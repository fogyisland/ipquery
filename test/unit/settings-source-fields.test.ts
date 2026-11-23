// SPDX-License-Identifier: MIT
//
// The settings page must not show a configuration for a data source
// the ETL pipeline does not run.
//
// The admin settings screen showed a "MaxMind · License Key" field and
// a "MaxMind · Editions" pill row. Both were read-only, and neither
// fed anything: the MaxMind parser was removed, and no pipeline step
// reads `cfg.maxmind`. An operator who opens the settings page sees a
// secret they are told is set, and a pair of editions the service
// claims to publish — for a source that is not in the table.
//
// The secret field is the worse of the two: it renders as a masked
// value with a reveal button. A masked value reads as "the server holds
// this", so an operator reasonably believes a MaxMind licence is
// configured and that city data from it is being loaded.
//
// The exception is the label string "MaxMind" on its own, which is
// also used as the i18n key's *value* in a place unrelated to the
// pipeline — but the settings view itself must not mention it.
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const root = path.resolve(__dirname, "..", "..");

const SETTINGS_VIEW = path.join(root, "src", "web", "views", "admin", "settings.hbs");

describe("The admin settings page", () => {
  it("shows no configuration for a source the pipeline does not run", () => {
    const view = fs.readFileSync(SETTINGS_VIEW, "utf8");
    // The MaxMind block: a label, a masked secret, an editions row.
    expect(view).not.toMatch(/maxmind/i);
  });

  it("shows no field the operator could mistake for a live setting", () => {
    const view = fs.readFileSync(SETTINGS_VIEW, "utf8");
    // A secret mask for a secret nothing reads is a lie about state.
    // The remaining secrets on the page (session, csrf, smtp) all feed
    // something the server uses.
    const maskedSecrets = view.match(/secret-mask/g) ?? [];
    const labels = view.match(/form-field-label[^>]*>([^<]*)</g) ?? [];
    expect(maskedSecrets.length).toBeGreaterThan(0);
    expect(labels.length).toBeGreaterThan(0);
  });
});
