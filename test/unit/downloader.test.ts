import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { downloadToFile } from '../../src/etl/downloader';

let server: http.Server;
let port: number;
let requests = 0;
let failFirstN = 0;
const payload = Buffer.from('hello world');

beforeAll(async () => {
  server = http.createServer((req, res) => {
    requests++;
    if (requests <= failFirstN) {
      res.statusCode = 503;
      res.end('busy');
      return;
    }
    res.statusCode = 200;
    res.end(payload);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  port = (server.address() as any).port;
});
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

describe('downloader', () => {
  it('downloads and writes file', async () => {
    failFirstN = 0; requests = 0;
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dl-'));
    const dest = path.join(tmp, 'out.bin');
    const r = await downloadToFile(`http://127.0.0.1:${port}/`, dest);
    expect(r.bytes).toBe(payload.length);
    expect(r.attempts).toBe(1);
    expect((await fs.readFile(dest)).equals(payload)).toBe(true);
  });

  it('retries on 5xx then succeeds', async () => {
    failFirstN = 2; requests = 0;
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dl-'));
    const dest = path.join(tmp, 'out.bin');
    const r = await downloadToFile(`http://127.0.0.1:${port}/`, dest, { retries: 3 });
    expect(r.attempts).toBe(3);
    expect(r.bytes).toBe(payload.length);
  });

  it('throws after exceeding retries', async () => {
    failFirstN = 99; requests = 0;
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dl-'));
    await expect(downloadToFile(`http://127.0.0.1:${port}/`, path.join(tmp, 'out.bin'), { retries: 2 }))
      .rejects.toThrow();
  });
});