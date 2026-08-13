// SPDX-License-Identifier: MIT
import { compareBuffers } from '../ip';
import type { Source, NormalizedRecord, IpRangeRow } from '../types';

const FIELD_MAP: Record<keyof Pick<IpRangeRow, 'countryCode' | 'city' | 'isp' | 'asn' | 'latitude'>, (keyof NormalizedRecord | [keyof NormalizedRecord, keyof NormalizedRecord])> = {
  countryCode: ['countryCode', 'countryName'],
  city: 'city',
  isp: 'isp',
  asn: 'asn',
  latitude: 'latitude',
};

const SOURCE_KEY_MAP: Record<keyof typeof FIELD_MAP, keyof IpRangeRow> = {
  countryCode: 'countrySource',
  city: 'citySource',
  isp: 'ispSource',
  asn: 'asnSource',
  latitude: 'geoSource',
};

function bufferAddOne(b: Buffer): Buffer {
  const out = Buffer.from(b);
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i]! < 0xff) { out[i] = out[i]! + 1; return out; }
    out[i] = 0;
  }
  return out; // overflow (255... +1) returns zero buffer
}

function bufferSubOne(b: Buffer): Buffer {
  const out = Buffer.from(b);
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i]! > 0) { out[i] = out[i]! - 1; return out; }
    out[i] = 0xff;
  }
  return out;
}

function hasField(rec: NormalizedRecord, key: keyof NormalizedRecord): boolean {
  const v = rec[key];
  return v !== undefined && v !== null && v !== '';
}

export function mergeByPriority(
  bySource: Map<Source, NormalizedRecord[]>,
  priority: Source[],
): IpRangeRow[] {
  // Gather all boundary IPs (start and end+1) so we can split into segments.
  const boundaries = new Set<string>();
  for (const records of bySource.values()) {
    for (const r of records) {
      boundaries.add(r.startIp.toString('hex'));
      boundaries.add(bufferAddOne(r.endIp).toString('hex'));
    }
  }
  const sortedHex = [...boundaries].sort();
  if (sortedHex.length < 2) return [];

  const out: IpRangeRow[] = [];
  for (let i = 0; i < sortedHex.length - 1; i++) {
    const segStart = Buffer.from(sortedHex[i]!, 'hex');
    const segEndExclusive = Buffer.from(sortedHex[i + 1]!, 'hex');
    const segEnd = bufferSubOne(segEndExclusive);
    if (compareBuffers(segStart, segEnd) > 0) continue;

    // Find an active record from each source covering this segment
    const activeBySource = new Map<Source, NormalizedRecord>();
    for (const source of priority) {
      const records = bySource.get(source) ?? [];
      const covering = records.find((r) =>
        compareBuffers(r.startIp, segStart) <= 0 && compareBuffers(r.endIp, segEnd) >= 0,
      );
      if (covering) activeBySource.set(source, covering);
    }
    if (activeBySource.size === 0) continue;

    const merged: IpRangeRow = { startIp: segStart, endIp: segEnd };
    for (const source of priority) {
      const rec = activeBySource.get(source);
      if (!rec) continue;
      for (const rowField of Object.keys(FIELD_MAP) as Array<keyof typeof FIELD_MAP>) {
        if (merged[rowField] !== undefined) continue;
        const recField = FIELD_MAP[rowField];
        const keys = Array.isArray(recField) ? recField : [recField];
        let chosen: keyof NormalizedRecord | undefined;
        let value: unknown;
        for (const k of keys) {
          if (hasField(rec, k)) {
            chosen = k;
            value = rec[k];
            break;
          }
        }
        if (chosen === undefined || value === undefined) continue;
        merged[rowField] = value as never;
        const sourceKey = SOURCE_KEY_MAP[rowField];
        (merged as unknown as Record<string, unknown>)[sourceKey] = source;
      }
    }
    out.push(merged);
  }
  return out;
}