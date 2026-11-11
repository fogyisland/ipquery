"use strict";
// SPDX-License-Identifier: MIT
//
// Provider adapters for the unknown-IP backfill job. All adapters conform
// to IpGeoProvider and return a rich result so the backfill job can
// distinguish "no data" from "we asked too fast and got rate-limited".
//
// Country / region / city / ASN are best-effort strings. Providers don't
// agree on spelling ("United States" vs "USA", "CA" vs "California") —
// matching at consensus time is done on the canonical 2-letter country code
// and on normalized city/region lower-case equality. See majority.ts.
Object.defineProperty(exports, "__esModule", { value: true });
//# sourceMappingURL=types.js.map