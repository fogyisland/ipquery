// SPDX-License-Identifier: MIT
import * as fs from "node:fs";
import * as readline from "node:readline";
import type { Source } from "../../types";
import type { EtlRunDownloadSource } from "../../storage/mysql";
import { parseIp } from "../../ip";
import {
  newStats,
  type AddressFamily,
  type CidrRange,
  type ParseStats,
  type ParseStreamResult,
  type SourceRecord,
} from "./types";

const ADDRESS_BITS = 128n;
const ALL_ONES = (1n << ADDRESS_BITS) - 1n;

function bufferToBigInt(buffer: Buffer): bigint {
  return BigInt(`0x${buffer.toString("hex")}`);
}

function bigIntToBuffer(value: bigint): Buffer {
  const hex = value.toString(16).padStart(32, "0");
  return Buffer.from(hex, "hex");
}

export function parseCidrLine(line: string): CidrRange | null {
  const text = line.trim();
  if (text === "" || text.startsWith("#") || text.startsWith("//")) return null;
  const separator = text.indexOf("/");
  const address = separator === -1 ? text : text.slice(0, separator);
  if (address.includes(":") && address.includes(".")) return null;
  const parsed = parseIp(address);
  if (!parsed) return null;
  const family: AddressFamily = address.includes(":") ? "v6" : "v4";
  const prefixText = separator === -1 ? null : text.slice(separator + 1);
  if (prefixText !== null && !/^\d{1,3}$/.test(prefixText)) return null;
  const prefix = prefixText === null ? (family === "v4" ? 32 : 128) : Number(prefixText);
  if (prefix < 0 || prefix > (family === "v4" ? 32 : 128)) return null;

  const offset = family === "v4" ? 96 : 0;
  const hostBits = BigInt(ADDRESS_BITS - BigInt(offset) - BigInt(prefix));
  const mask = hostBits === 0n ? ALL_ONES : (ALL_ONES << hostBits) & ALL_ONES;
  const addressValue = bufferToBigInt(parsed);
  const startValue = addressValue & mask;
  const endValue = startValue | ((1n << hostBits) - 1n);
  return {
    startIp: bigIntToBuffer(startValue),
    endIp: bigIntToBuffer(endValue),
    countryCode: "CN",
    family,
  };
}

async function* parseCidrLines(
  filePath: string,
  stats: ParseStats,
  source: Source,
  etlSource: EtlRunDownloadSource,
  expectedFamily: AddressFamily,
): AsyncIterable<SourceRecord> {
  const lines = readline.createInterface({
    input: fs.createReadStream(filePath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  try {
    for await (const line of lines) {
      const range = parseCidrLine(line);
      if (!range) {
        const trimmed = line.trim();
        if (trimmed !== "" && !trimmed.startsWith("#") && !trimmed.startsWith("//")) {
          stats.skipped.unparseableIp += 1;
        }
        continue;
      }
      if (range.family !== expectedFamily) {
        stats.skipped.other += 1;
        continue;
      }
      stats.rowsEmitted += 1;
      yield {
        startIp: range.startIp,
        endIp: range.endIp,
        countryCode: range.countryCode,
        source,
        etlSource,
        family: range.family,
      };
    }
  } finally {
    lines.close();
  }
}

function parseCidrStreamWithStats(
  filePath: string,
  source: Source,
  etlSource: EtlRunDownloadSource,
  expectedFamily: AddressFamily,
): ParseStreamResult<SourceRecord> {
  const stats = newStats();
  return {
    records: parseCidrLines(filePath, stats, source, etlSource, expectedFamily),
    stats,
  };
}

export function parseMetowolfCidrStreamWithStats(filePath: string): ParseStreamResult<SourceRecord> {
  return parseCidrStreamWithStats(filePath, "metowolf-cn", "metowolf-cn", "v4");
}

export function parseRunishiwoV4CidrStreamWithStats(filePath: string): ParseStreamResult<SourceRecord> {
  return parseCidrStreamWithStats(filePath, "runishiwo-cn", "runishiwo-cn", "v4");
}

export function parseRunishiwoV6CidrStreamWithStats(filePath: string): ParseStreamResult<SourceRecord> {
  return parseCidrStreamWithStats(filePath, "runishiwo-cn", "runishiwo-v6", "v6");
}
