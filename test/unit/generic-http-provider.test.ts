// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GenericHttpProvider, type GenericProviderRow } from '../../src/etl/genericHttpProvider';

// Mock DNS so the SSRF re-check inside GenericHttpProvider accepts the
// test hostnames without actually hitting the resolver. By default every
// hostname resolves to 1.1.1.1 (safe, public IP). Tests that need a
// different answer use `dnsLookup.mockResolvedValueOnce(...)`.
vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async (_host: string, _opts?: unknown) => {
    return [{ address: '1.1.1.1', family: 4 }];
  }),
}));

function makeRow(over: Partial<GenericProviderRow> = {}): GenericProviderRow {
  return {
    name: 'custom-1',
    urlTemplate: 'https://api.example.com/{ip}',
    method: 'GET',
    requestBody: null,
    responseFormat: 'json',
    countryPath: 'country.code',
    cityPath: null,
    asnPath: null,
    timeoutMs: 1000,
    apiKey: null,
    ...over,
  };
}

interface MockFetchResponse {
  status: number;
  body: string;
  ok?: boolean;
}

function mockFetch(responses: MockFetchResponse[], opts: { delayMs?: number; throwAbort?: boolean } = {}) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = typeof url === 'string' ? url : url.toString();
    calls.push({ url: u, init });
    const r = responses.shift();
    if (!r) throw new Error('no mock responses left');
    if (opts.throwAbort) {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    }
    if (opts.delayMs) await new Promise((res) => setTimeout(res, opts.delayMs));
    return new Response(r.body, { status: r.status, headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fn);
  return { fn, calls };
}

beforeEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('GenericHttpProvider', () => {
  it('substitutes {ip} and {apiKey} in the URL template', async () => {
    const { fn, calls } = mockFetch([{ status: 200, body: '{"country":{"code":"US"},"city":"NYC"}' }]);
    const p = new GenericHttpProvider(makeRow({
      urlTemplate: 'https://api.example.com/{ip}?key={apiKey}',
      apiKey: 'sk-123',
      cityPath: 'city',
    }));
    const r = await p.lookup('8.8.8.8');
    expect(r.record?.countryCode).toBe('US');
    expect(r.record?.city).toBe('NYC');
    expect(calls[0]?.url).toBe('https://api.example.com/8.8.8.8?key=sk-123');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('extracts countryCode, city, asn via dot-paths', async () => {
    mockFetch([{ status: 200, body: '{"country":{"code":"DE"},"city":{"name":"Berlin"},"asn":3320}' }]);
    const p = new GenericHttpProvider(makeRow({
      countryPath: 'country.code',
      cityPath: 'city.name',
      asnPath: 'asn',
    }));
    const r = await p.lookup('1.2.3.4');
    expect(r.record?.countryCode).toBe('DE');
    expect(r.record?.city).toBe('Berlin');
    expect(r.record?.asn).toBe(3320);
  });

  it('POST with body template substitutes placeholders + sends JSON', async () => {
    const { calls } = mockFetch([{ status: 200, body: '{"country":{"code":"FR"}}' }]);
    const p = new GenericHttpProvider(makeRow({
      method: 'POST',
      urlTemplate: 'https://api.example.com/lookup',
      requestBody: '{"ip":"{ip}","key":"{apiKey}"}',
      apiKey: 'k',
    }));
    const r = await p.lookup('5.6.7.8');
    expect(r.record?.countryCode).toBe('FR');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(calls[0]?.init?.body).toBe('{"ip":"5.6.7.8","key":"k"}');
    const headers = calls[0]?.init?.headers as Record<string, string> | undefined;
    expect(headers?.['Content-Type']).toBe('application/json');
  });

  it('returns TIMEOUT when AbortController fires', async () => {
    vi.useFakeTimers();
    try {
      // Build the mock manually so we control when the promise resolves.
      const fetchPromise = new Promise<Response>((_resolve, reject) => {
        // Never resolve — abort should fire first.
        setImmediate(() => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
      vi.stubGlobal('fetch', vi.fn(async () => fetchPromise));
      const p = new GenericHttpProvider(makeRow({ timeoutMs: 50 }));
      const lookupPromise = p.lookup('1.1.1.1');
      // Advance fake timers past the timeoutMs.
      vi.advanceTimersByTime(60);
      const r = await lookupPromise;
      expect(r.rateLimited).toBe(false);
      expect(r.errorCode).toBe('timeout');
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns rateLimited=true + errorCode 429 when upstream returns HTTP 429', async () => {
    mockFetch([{ status: 429, body: 'rate limited' }]);
    const p = new GenericHttpProvider(makeRow());
    const r = await p.lookup('1.1.1.1');
    expect(r.rateLimited).toBe(true);
    expect(r.errorCode).toBe('429');
  });

  it('falls back to text regex for non-JSON responses', async () => {
    mockFetch([{ status: 200, body: 'ISO country: US' }]);
    const p = new GenericHttpProvider(makeRow({
      urlTemplate: 'https://example.com/{ip}',
      responseFormat: 'text',
      countryPath: 'country.code',
    }));
    const r = await p.lookup('1.1.1.1');
    expect(r.record?.countryCode).toBe('US');
  });

  it('returns NO_COUNTRY when field mapping yields no country code', async () => {
    mockFetch([{ status: 200, body: '{"city":"nowhere"}' }]);
    const p = new GenericHttpProvider(makeRow({
      countryPath: 'country.code',
      cityPath: 'city',
    }));
    const r = await p.lookup('1.1.1.1');
    expect(r.errorCode).toBe('NO_COUNTRY');
    expect(r.record).toBeNull();
  });

  it('SSRF re-check blocks 127.0.0.1 even after URL was set', async () => {
    const p = new GenericHttpProvider(makeRow({
      urlTemplate: 'http://127.0.0.1/foo/{ip}',
    }));
    const r = await p.lookup('1.1.1.1');
    expect(r.errorCode).toBe('SSRF_BLOCKED');
    expect(r.record).toBeNull();
  });

  it('accepts a Buffer for ip input (backfill passes Buffer)', async () => {
    mockFetch([{ status: 200, body: '{"country":{"code":"JP"}}' }]);
    const p = new GenericHttpProvider(makeRow());
    // IPv4-mapped buffer for 8.8.8.8 (matches the convention the rest of
    // the codebase uses; 10 bytes of 0 + 0xFFFF + 4 IPv4 bytes).
    const buf = Buffer.alloc(16);
    buf[10] = 0xff; buf[11] = 0xff;
    buf[12] = 8; buf[13] = 8; buf[14] = 8; buf[15] = 8;
    const r = await p.lookup(buf);
    expect(r.record?.countryCode).toBe('JP');
  });
});
