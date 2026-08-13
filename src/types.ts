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

export type Role = 'user' | 'admin';
export type QueryStatus = 'hit' | 'miss' | 'invalid';

export interface User {
  id: number;
  email: string;
  displayName: string;
  role: Role;
  emailVerified: boolean;
  isDisabled: boolean;
  createdAt: Date;
  lastLoginAt: Date | null;
}

export interface ApiKey {
  id: number;
  userId: number;
  label: string;
  keyPrefix: string;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
}

export interface Session {
  id: string;
  userId: number;
  expiresAt: Date;
  createdAt: Date;
}

export interface EmailVerification {
  id: number;
  userId: number;
  tokenHash: string;
  expiresAt: Date;
  consumedAt: Date | null;
}

export interface PasswordReset {
  id: number;
  userId: number;
  tokenHash: string;
  expiresAt: Date;
  consumedAt: Date | null;
}

export interface QueryLogEntry {
  ts: Date;
  ip: Buffer;
  ipText: string;
  status: QueryStatus;
  userId: number | null;
  apiKeyId: number | null;
  sessionId: string | null;
  remoteAddr: Buffer | null;
  userAgent: string | null;
}
