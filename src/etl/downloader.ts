// SPDX-License-Identifier: MIT
import * as fs from 'node:fs/promises';
import * as fssync from 'node:fs';
import * as path from 'node:path';

export interface DownloadResult { bytes: number; attempts: number }

const BACKOFF_MS = [5_000, 15_000, 45_000];
function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }

export async function downloadToFile(
  url: string, destPath: string, opts: { retries?: number; timeoutMs?: number } = {},
): Promise<DownloadResult> {
  const retries = opts.retries ?? 3;
  const timeoutMs = opts.timeoutMs ?? 60_000;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      await fs.mkdir(path.dirname(destPath), { recursive: true });
      const tmp = destPath + '.part';
      await fs.writeFile(tmp, buf);
      await fs.rename(tmp, destPath);
      clearTimeout(timer);
      return { bytes: buf.length, attempts: attempt };
    } catch (err) {
      lastErr = err;
      if (attempt < retries) {
        await sleep(BACKOFF_MS[attempt - 1] ?? 45_000);
      }
    }
  }
  throw new Error(`Download failed after ${retries} attempts: ${String(lastErr)}`);
}

// Tag to silence unused-import linter when fs sync APIs not needed
void fssync;