// SPDX-License-Identifier: MIT
export function isValidIp(s: string): boolean {
  if (typeof s !== 'string' || s.length === 0) return false;
  // Cheap pre-check: only contains digits, dots, colons, a-f, A-F
  if (!/^[0-9a-fA-F:.]+$/.test(s)) return false;
  return parseIp(s) !== null;
}

export function parseIp(s: string): Buffer | null {
  if (typeof s !== 'string' || s.length === 0) return null;
  if (s.includes(':')) return parseV6(s);
  if (s.includes('.')) return parseV4(s);
  return null;
}

function parseV4(s: string): Buffer | null {
  const parts = s.split('.');
  if (parts.length !== 4) return null;
  const buf = Buffer.alloc(16);
  for (let i = 0; i < 4; i++) {
    const part = parts[i]!;
    if (!/^\d+$/.test(part)) return null;
    const n = Number(part);
    if (n < 0 || n > 255) return null;
    buf[12 + i] = n;
  }
  return buf;
}

function parseV6(s: string): Buffer | null {
  // Handle :: abbreviation
  const buf = Buffer.alloc(16);
  let head: number[] = [];
  let tail: number[] = [];
  let foundDoubleColon = false;
  let doubleColonIndex = -1;

  if (s === '::') {
    return buf;
  }

  const sides = s.split('::');
  if (sides.length > 2) return null;
  const leftPart = sides[0] ?? '';
  const rightPart = sides[1] ?? '';

  if (leftPart.length > 0) {
    for (const part of leftPart.split(':')) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(part)) return null;
      head.push(parseInt(part, 16));
    }
  }
  if (rightPart.length > 0) {
    for (const part of rightPart.split(':')) {
      if (!/^[0-9A-Fa-f]{1,4}$/.test(part)) return null;
      tail.push(parseInt(part, 16));
    }
  }
  if (sides.length === 2) {
    foundDoubleColon = true;
    doubleColonIndex = head.length;
  }

  const total = head.length + tail.length;
  if (foundDoubleColon) {
    if (total > 8) return null;
    const fill = 8 - total;
    const combined = [...head, ...new Array(fill).fill(0), ...tail];
    for (let i = 0; i < 8; i++) {
      const v = combined[i]!;
      buf[i * 2] = (v >> 8) & 0xff;
      buf[i * 2 + 1] = v & 0xff;
    }
  } else {
    if (total !== 8) return null;
    const combined = [...head, ...tail];
    for (let i = 0; i < 8; i++) {
      const v = combined[i]!;
      buf[i * 2] = (v >> 8) & 0xff;
      buf[i * 2 + 1] = v & 0xff;
    }
  }
  return buf;
}

export function bufferToString(b: Buffer): string {
  if (b.length !== 16) throw new Error('expected 16-byte buffer');
  // IPv4 if first 12 bytes are zero
  if (b[0] === 0 && b[1] === 0 && b[2] === 0 && b[3] === 0 &&
      b[4] === 0 && b[5] === 0 && b[6] === 0 && b[7] === 0 &&
      b[8] === 0 && b[9] === 0 && b[10] === 0 && b[11] === 0) {
    return `${b[12]}.${b[13]}.${b[14]}.${b[15]}`;
  }
  const groups: number[] = [];
  for (let i = 0; i < 8; i++) {
    groups.push((b[i * 2]! << 8) | b[i * 2 + 1]!);
  }
  // Find longest run of zeros for :: abbreviation
  let bestStart = -1, bestLen = 0;
  let curStart = -1, curLen = 0;
  for (let i = 0; i < 8; i++) {
    if (groups[i] === 0) {
      if (curStart === -1) curStart = i;
      curLen++;
      if (curLen > bestLen) { bestLen = curLen; bestStart = curStart; }
    } else {
      curStart = -1; curLen = 0;
    }
  }
  if (bestLen < 2) {
    return groups.map((g) => g.toString(16)).join(':');
  }
  const head = groups.slice(0, bestStart).map((g) => g.toString(16));
  const tail = groups.slice(bestStart + bestLen).map((g) => g.toString(16));
  return `${head.join(':')}::${tail.join(':')}`;
}

export function compareBuffers(a: Buffer, b: Buffer): number {
  if (a.length !== b.length) return a.length - b.length;
  for (let i = 0; i < a.length; i++) {
    const diff = a[i]! - b[i]!;
    if (diff !== 0) return diff;
  }
  return 0;
}