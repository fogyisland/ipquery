// SPDX-License-Identifier: MIT
export type Source = 'maxmind' | 'ip2region' | 'dbip';

export interface NormalizedRecord {
  startIp: Buffer;
  endIp: Buffer;
  countryCode?: string;
  countryName?: string;
  region?: string;
  city?: string;
  postalCode?: string;
  latitude?: number;
  longitude?: number;
  timezone?: string;
  isp?: string;
  asn?: number;
  asnOrg?: string;
  source: Source;
}

export interface LookupResult {
  ip: string;
  country: { code?: string; name?: string; source: Source };
  region?: string;
  city?: { name?: string; source: Source };
  postalCode?: string;
  location?: { lat: number; lon: number; source: Source };
  timezone?: string;
  isp?: { name?: string; source: Source };
  asn?: { number: number; org?: string; source: Source };
  etag: string;
}

export interface EtlRun {
  id?: number;
  startedAt: Date;
  finishedAt?: Date;
  status: 'running' | 'success' | 'failed';
  maxmindRecords?: number;
  ip2regionRecords?: number;
  dbipRecords?: number;
  mergedRecords?: number;
  errorMessage?: string;
  maxmindBuiltAt?: Date;
  ip2regionBuiltAt?: Date;
  dbipBuiltAt?: Date;
}

export interface IpRangeRow {
  startIp: Buffer;
  endIp: Buffer;
  countryCode?: string;
  countryName?: string;
  region?: string;
  city?: string;
  postalCode?: string;
  latitude?: number;
  longitude?: number;
  timezone?: string;
  isp?: string;
  asn?: number;
  asnOrg?: string;
  countrySource?: Source;
  citySource?: Source;
  ispSource?: Source;
  asnSource?: Source;
  geoSource?: Source;
}
