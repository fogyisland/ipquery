// SPDX-License-Identifier: MIT
//
// GenericHttpProvider — instantiates at runtime from an ingest_providers
// row where is_custom=1. Replaces the URL template with the queried IP
// and (if set) the stored API key, makes the HTTP request, parses the
// JSON response using dot-path field mappings, and returns a normal
// IpGeoLookupResult so it joins the rest of the pipeline untouched.

import type { IpGeoProvider, IpGeoLookupResult } from './providers/types';
import { bufferToString } from '../ip';
import { assertSafeHttpUrl } from '../storage/ssrf';

export interface GenericProviderRow {
  name: string;
  urlTemplate: string;
  method: 'GET' | 'POST';
  requestBody: string | null;
  responseFormat: 'json' | 'text';
  countryPath: string | null;
  cityPath: string | null;
  asnPath: string | null;
  timeoutMs: number | null;
  apiKey: string | null;
}

export class GenericHttpProvider implements IpGeoProvider {
  readonly name: string;
  constructor(private readonly row: GenericProviderRow) {
    this.name = row.name;
  }

  async lookup(ipOrBuffer: string | Buffer): Promise<IpGeoLookupResult> {
    const ipStr = typeof ipOrBuffer === 'string' ? ipOrBuffer : bufferToString(ipOrBuffer);
    const apiKey = this.row.apiKey ?? null;
    const url = this.row.urlTemplate
      .replaceAll('{ip}', encodeURIComponent(ipStr))
      .replaceAll('{apiKey}', encodeURIComponent(apiKey ?? ''));
    // SSRF re-check before each request (defends against DNS rebinding).
    const ssrf = await assertSafeHttpUrl(url);
    if (!ssrf.ok) {
      return { record: null, rateLimited: false, errorCode: 'SSRF_BLOCKED', rawResponse: ssrf.reason };
    }
    const timeoutMs = this.row.timeoutMs ?? 5000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const init: RequestInit = {
        method: this.row.method,
        signal: controller.signal,
        headers: { 'User-Agent': 'IPQuery/1.0 (+custom-provider)' },
      };
      if (this.row.method === 'POST' && this.row.requestBody) {
        const body = this.row.requestBody
          .replaceAll('{ip}', ipStr)
          .replaceAll('{apiKey}', apiKey ?? '');
        init.body = body;
        (init.headers as Record<string, string>)['Content-Type'] = 'application/json';
      }
      const res = await fetch(url, init);
      if (res.status === 429) {
        return { record: null, rateLimited: true, errorCode: '429', rawResponse: await safeBody(res) };
      }
      if (!res.ok) {
        return { record: null, rateLimited: false, errorCode: String(res.status), rawResponse: await safeBody(res) };
      }
      const body = await res.text();
      if (this.row.responseFormat === 'text' || body.length > 100_000) {
        return this.parseTextFallback(body);
      }
      let json: unknown;
      try { json = JSON.parse(body); } catch { return this.parseTextFallback(body); }
      const get = (path: string | null) => path ? readPath(json, path) : undefined;
      const countryRaw = get(this.row.countryPath);
      const countryCode = countryRaw != null ? String(countryRaw).toUpperCase().slice(0, 2) : '';
      const cityRaw = get(this.row.cityPath);
      const city = cityRaw != null ? String(cityRaw) : '';
      const asnRaw = get(this.row.asnPath);
      const asn = asnRaw != null && asnRaw !== '' ? Number(asnRaw) : null;
      if (!countryCode || countryCode === 'UN') {
        return { record: null, rateLimited: false, errorCode: 'NO_COUNTRY', rawResponse: body.slice(0, 240) };
      }
      return {
        record: {
          countryCode,
          countryName: '',
          region: null,
          city,
          latitude: null,
          longitude: null,
          timezone: null,
          isp: null,
          asn: Number.isFinite(asn) ? asn : null,
          asnOrg: null,
        },
        rateLimited: false,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const code = msg.includes('abort') ? 'timeout' : 'network';
      return { record: null, rateLimited: false, errorCode: code, rawResponse: msg.slice(0, 240) };
    } finally {
      clearTimeout(timer);
    }
  }

  private parseTextFallback(body: string): IpGeoLookupResult {
    // Best-effort: regex out a 2-letter country code from the response.
    const m = body.match(/\b([A-Z]{2})\b/);
    if (m && m[1]) {
      return {
        record: { countryCode: m[1], countryName: '', region: null, city: '',
          latitude: null, longitude: null, timezone: null, isp: null, asn: null, asnOrg: null },
        rateLimited: false,
      };
    }
    return { record: null, rateLimited: false, errorCode: 'PARSE_FAIL', rawResponse: body.slice(0, 240) };
  }
}

async function safeBody(res: Response): Promise<string | null> {
  try {
    const text = await res.text();
    return text.length > 240 ? text.slice(0, 240) : text;
  } catch {
    return null;
  }
}

function readPath(obj: unknown, path: string): unknown {
  // Dot path: a.b.c -> obj['a']['b']['c']. Returns undefined if any segment missing.
  if (obj == null || typeof obj !== 'object') return undefined;
  let cur: unknown = obj;
  for (const seg of path.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}
