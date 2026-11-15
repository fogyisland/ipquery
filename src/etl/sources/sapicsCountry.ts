// SPDX-License-Identifier: MIT
import * as fs from "node:fs";
import * as readline from "node:readline";
import { countryNamesFor } from "../../country-names";
import { compareBuffers, parseIp } from "../../ip";
import { parseCsvLine } from "./dbip";
import {
  newStats,
  type AddressFamily,
  type CidrRange,
  type ParseStats,
  type ParseStreamResult,
  type SourceRecord,
} from "./types";

export function parseSapicsCountryCsvLine(line: string): CidrRange | null {
  const fields = parseCsvLine(line);
  if (fields.length < 3) return null;
  const startText = fields[0]!.trim();
  const endText = fields[1]!.trim();
  const code = fields[2]!.trim().toUpperCase();
  if (!countryNamesFor(code)) return null;
  if (startText.includes(":") && startText.includes(".")) return null;
  if (endText.includes(":") && endText.includes(".")) return null;
  const startIp = parseIp(startText);
  const endIp = parseIp(endText);
  if (!startIp || !endIp || compareBuffers(startIp, endIp) > 0) return null;
  const family: AddressFamily = startText.includes(":") ? "v6" : "v4";
  if (family !== (endText.includes(":") ? "v6" : "v4")) return null;
  return { startIp, endIp, countryCode: code, family };
}

async function* parseSapicsCountryLines(
  filePath: string,
  stats: ParseStats,
): AsyncIterable<SourceRecord> {
  const lines = readline.createInterface({
    input: fs.createReadStream(filePath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  try {
    for await (const line of lines) {
      const trimmed = line.trim();
      if (trimmed === "" || trimmed.startsWith("#")) continue;
      const fields = parseCsvLine(trimmed);
      if (fields.length < 3) {
        stats.skipped.shortLine += 1;
        continue;
      }
      const startText = fields[0]!.trim();
      const endText = fields[1]!.trim();
      if (
        (startText.includes(":") && startText.includes(".")) ||
        (endText.includes(":") && endText.includes("."))
      ) {
        stats.skipped.missingCol += 1;
        continue;
      }
      const code = fields[2]!.trim().toUpperCase();
      if (!countryNamesFor(code)) {
        stats.skipped.missingCol += 1;
        continue;
      }
      const range = parseSapicsCountryCsvLine(trimmed);
      if (!range) {
        stats.skipped.other += 1;
        continue;
      }
      stats.rowsEmitted += 1;
      yield {
        startIp: range.startIp,
        endIp: range.endIp,
        countryCode: range.countryCode,
        source: "sapics-user",
        etlSource: "sapics-user",
        family: range.family,
      };
    }
  } finally {
    lines.close();
  }
}

export function parseSapicsCountryStreamWithStats(
  filePath: string,
): ParseStreamResult<SourceRecord> {
  const stats = newStats();
  return { records: parseSapicsCountryLines(filePath, stats), stats };
}
