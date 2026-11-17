// SPDX-License-Identifier: MIT
//
// The .ipq range file format.
//
// One JSON object per line: a header first, then one row per IP range. It is
// the same file for export and import, so an operator can move ranges from
// one install to another by downloading a file and uploading it back.
//
// Why JSON Lines and not a binary format, a CSV, or a single JSON array:
//
//   · An array has to be read whole before anything can be done with it.
//     A library-sized export is around two gigabytes; this way the exporter
//     streams line by line and the importer reads what it needs.
//   · CSV would need a column-order contract, and the moment a column is
//     added the older files mean something different.
//   · A binary format needs a parser, a byte-order decision and a tool of
//     its own to inspect. An operator debugging a bad import can read this
//     file, grep it, and diff two of them.
//
// The header is not decoration. It is what makes a truncated download
// detectable: a file without it is refused outright rather than imported as
// "zero ranges, everything went fine".
import { isValidIp, parseIp, compareBuffers } from "../ip";

export const IPQ_FORMAT = "ipquery-ranges";
export const IPQ_VERSION = 1;

/** The most a single import reads, unless the caller says otherwise. */
export const IPQ_DEFAULT_MAX_ROWS = 1_000_000;

export interface RangeFileHeader {
  readonly format: string;
  readonly version: number;
  readonly exportedAt: string;
  readonly rows: number;
}

/** One range, as text. The addresses stay textual all the way through the
 *  file: a BINARY(16) column cannot tell an operator which row is wrong. */
export interface RangeRecord {
  /** 1-based line this record came from. 0 for one built in memory (the
   *  exporter). Reported with a write failure so the operator can open the
   *  file at the right place. */
  readonly line: number;
  readonly start: string;
  readonly end: string;
  readonly countryCode: string | null;
  readonly countryName: string | null;
  readonly region: string | null;
  readonly city: string | null;
  readonly postalCode: string | null;
  readonly latitude: number | null;
  readonly longitude: number | null;
  readonly timezone: string | null;
  readonly isp: string | null;
  readonly asn: number | null;
  readonly asnOrg: string | null;
}

/** The row shape the exporter hands over. Field names are the database's,
 *  camelCased; `encodeRange` is the only place that knows the file's own
 *  spelling. */
export type RangeRow = RangeRecord;

/** A file that cannot be imported. The message names the line, because the
 *  operator is holding the file and has nothing else to go on. */
export class RangeFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RangeFileError";
  }
}

/** Which columns the file writes. A field listed here is written when it
 *  has a value and left out when it does not. */
const FIELDS: ReadonlyArray<readonly [keyof RangeRow, string]> = [
  ["countryCode", "country"],
  ["countryName", "countryName"],
  ["region", "region"],
  ["city", "city"],
  ["postalCode", "postalCode"],
  ["latitude", "lat"],
  ["longitude", "lon"],
  ["timezone", "timezone"],
  ["isp", "isp"],
  ["asn", "asn"],
  ["asnOrg", "asnOrg"],
];

export function encodeHeader(meta: { exportedAt: string; rows: number }): string {
  return JSON.stringify({
    format: IPQ_FORMAT,
    version: IPQ_VERSION,
    exportedAt: meta.exportedAt,
    rows: meta.rows,
  });
}

export function encodeRange(row: RangeRow): string {
  const out: Record<string, unknown> = { start: row.start, end: row.end };
  for (const [field, name] of FIELDS) {
    const value = row[field];
    if (value === null || value === undefined || value === "") continue;
    out[name] = value;
  }
  return JSON.stringify(out);
}

export interface DecodeOptions {
  /** Rows past this many stop the import. Defaults to the import ceiling. */
  readonly maxRows?: number;
}

export interface DecodedRangeFile {
  readonly header: RangeFileHeader;
  readonly ranges: readonly RangeRecord[];
}

/**
 * Read a whole .ipq file held in memory.
 *
 * The streaming path (`readRangeFileStream`) is what the route uses for an
 * upload; this one exists for the parts that are easier to state as data —
 * a pasted snippet, a fixture, and every test of the format itself.
 */
export function decodeFile(text: string, options: DecodeOptions = {}): DecodedRangeFile {
  const maxRows = options.maxRows ?? IPQ_DEFAULT_MAX_ROWS;
  const lines = text.split(/\r?\n/);
  const header = parseHeader(lines[0] ?? "");
  const ranges: RangeRecord[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === "") continue;
    if (ranges.length >= maxRows) {
      throw new RangeFileError(
        `this file holds more than ${maxRows} ranges; split it or raise the ceiling before importing`,
      );
    }
    // The record carries its own line number so a write failure can be
    // reported against the line the operator has to look at.
    ranges.push(parseRangeLine(line, i + 1));
  }
  return { header, ranges };
}

function parseHeader(line: string): RangeFileHeader {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new RangeFileError(
      `line 1: this is not an .ipq file — the first line must be the format header, ` +
        `and it could not be read as JSON`,
    );
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new RangeFileError("line 1: the format header must be a JSON object");
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.format !== IPQ_FORMAT) {
    throw new RangeFileError(
      `line 1: this is not an ipquery-ranges file (found format ${JSON.stringify(obj.format)})`,
    );
  }
  const version = Number(obj.version);
  if (version !== IPQ_VERSION) {
    throw new RangeFileError(
      `line 1: this file is version ${String(obj.version)}, and this build reads version ${IPQ_VERSION}. ` +
        `Upgrade the server, or export the file again from a build that writes that version.`,
    );
  }
  return {
    format: IPQ_FORMAT,
    version: IPQ_VERSION,
    exportedAt: typeof obj.exportedAt === "string" ? obj.exportedAt : "",
    rows: typeof obj.rows === "number" ? obj.rows : 0,
  };
}

function parseRangeLine(line: string, lineNumber: number): RangeRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new RangeFileError(`line ${lineNumber}: this line is not valid JSON`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new RangeFileError(`line ${lineNumber}: expected a JSON object describing one range`);
  }
  const obj = parsed as Record<string, unknown>;
  const start = readAddress(obj.start, "start", lineNumber);
  const end = readAddress(obj.end, "end", lineNumber);
  const startBuf = parseIp(start)!;
  const endBuf = parseIp(end)!;
  // The two families share a 16-byte column: an IPv4 address is stored in
  // the last four bytes with twelve zeros in front. A file that mixes them
  // produces a range spanning most of the IPv6 space, and the lookup would
  // then answer with this row for addresses it has nothing to do with.
  if (isV6(start) !== isV6(end)) {
    throw new RangeFileError(
      `line ${lineNumber}: the range mixes IPv4 and IPv6 (${start} → ${end})`,
    );
  }
  if (compareBuffers(startBuf, endBuf) > 0) {
    throw new RangeFileError(
      `line ${lineNumber}: range ends before it starts (${start} → ${end})`,
    );
  }
  return {
    line: lineNumber,
    start,
    end,
    countryCode: readText(obj.country, "country", lineNumber),
    countryName: readText(obj.countryName, "countryName", lineNumber),
    region: readText(obj.region, "region", lineNumber),
    city: readText(obj.city, "city", lineNumber),
    postalCode: readText(obj.postalCode, "postalCode", lineNumber),
    latitude: readNumber(obj.lat, "lat", lineNumber),
    longitude: readNumber(obj.lon, "lon", lineNumber),
    timezone: readText(obj.timezone, "timezone", lineNumber),
    isp: readText(obj.isp, "isp", lineNumber),
    asn: readInteger(obj.asn, "asn", lineNumber),
    asnOrg: readText(obj.asnOrg, "asnOrg", lineNumber),
  };
}

/** An address written either way parses to 16 bytes; only the original text
 *  says which family it was. */
function isV6(address: string): boolean {
  return address.includes(":");
}

function readAddress(value: unknown, name: string, lineNumber: number): string {
  if (typeof value !== "string" || value === "") {
    throw new RangeFileError(`line ${lineNumber}: "${name}" must be an IP address`);
  }
  if (!isValidIp(value)) {
    throw new RangeFileError(`line ${lineNumber}: "${name}" is not a valid IP address: ${value}`);
  }
  return value;
}

function readText(value: unknown, name: string, lineNumber: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new RangeFileError(`line ${lineNumber}: "${name}" must be text`);
  }
  return value === "" ? null : value;
}

function readNumber(value: unknown, name: string, lineNumber: number): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new RangeFileError(`line ${lineNumber}: "${name}" must be a number`);
  }
  return value;
}

function readInteger(value: unknown, name: string, lineNumber: number): number | null {
  const n = readNumber(value, name, lineNumber);
  if (n === null) return null;
  // asn is INT UNSIGNED in the table. A negative or fractional ASN in a
  // hand-edited file would otherwise fail at INSERT with a driver error
  // that names a column instead of a line.
  if (!Number.isInteger(n) || n < 0) {
    throw new RangeFileError(`line ${lineNumber}: "${name}" must be a whole number`);
  }
  return n;
}

export interface StreamOptions {
  readonly maxRows?: number;
  /** Rows handed to `onBatch` at a time. One INSERT per row is what makes a
   *  nine-million-row import take hours. */
  readonly batchSize?: number;
  /** Called once, before the first batch, with the parsed header. A refusal
   *  belongs here: nothing should be written into a staging table for a file
   *  this build cannot read. */
  readonly onHeader: (header: RangeFileHeader) => void | Promise<void>;
  readonly onBatch: (rows: readonly RangeRecord[]) => Promise<void>;
}

const DEFAULT_BATCH_SIZE = 500;

/**
 * Read a .ipq file straight from a stream.
 *
 * The file is line-delimited, so the reader only has to hold the line it is
 * in the middle of: memory is bounded by the longest line, not by the file.
 * A whole-library export is around two gigabytes, which is more than a
 * String can hold once, so reading it as text and splitting afterwards is
 * not an option.
 *
 * A partial line at the end of a chunk is carried into the next one. Getting
 * that wrong is the difference between "works" and "loses a row every 64 KB
 * depending on where the socket happened to split".
 */
export async function decodeStream(
  input: AsyncIterable<Buffer | string>,
  options: StreamOptions,
): Promise<void> {
  const maxRows = options.maxRows ?? IPQ_DEFAULT_MAX_ROWS;
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  let buffer = "";
  let lineNumber = 0;
  let sawHeader = false;
  let seenRows = 0;
  let batch: RangeRecord[] = [];

  const flush = async (): Promise<void> => {
    if (batch.length === 0) return;
    const outgoing = batch;
    batch = [];
    await options.onBatch(outgoing);
  };

  const consumeLine = async (line: string): Promise<void> => {
    lineNumber += 1;
    if (lineNumber === 1) {
      // A byte-order mark is what a Windows browser puts in front of a
      // pasted file. Left in, the first line is not JSON.
      const header = parseHeader(line.replace(/^﻿/, ""));
      sawHeader = true;
      await options.onHeader(header);
      return;
    }
    if (line.trim() === "") return;
    seenRows += 1;
    if (seenRows > maxRows) {
      throw new RangeFileError(
        `this file holds more than ${maxRows} ranges; split it or raise the ceiling before importing`,
      );
    }
    batch.push(parseRangeLine(line, lineNumber));
    if (batch.length >= batchSize) await flush();
  };

  for await (const chunk of input) {
    buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline).replace(/\r$/, "");
      buffer = buffer.slice(newline + 1);
      await consumeLine(line);
      newline = buffer.indexOf("\n");
    }
  }
  // A last line without a trailing newline is still a line.
  if (buffer.trim() !== "") await consumeLine(buffer.replace(/\r$/, ""));
  if (!sawHeader) {
    throw new RangeFileError(
      "line 1: the file is empty — an .ipq file starts with a format header",
    );
  }
  await flush();
}
