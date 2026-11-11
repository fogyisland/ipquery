export type Source = "maxmind" | "ip2region" | "dbip" | "dbip-country" | "dbip-asn" | "ipinfo";
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
    country: {
        code?: string;
        name?: string;
        source: Source;
    };
    region?: string;
    city?: {
        name?: string;
        source: Source;
    };
    postalCode?: string;
    location?: {
        lat: number;
        lon: number;
        source: Source;
    };
    timezone?: string;
    isp?: {
        name?: string;
        source: Source;
    };
    asn?: {
        number: number;
        org?: string;
        source: Source;
    };
    etag: string;
}
/** Lifecycle stage of an in-flight ETL run. Used by the admin UI to
 *  colour the live progress panel and to suppress out-of-order bar
 *  updates (insert can't run before download completes, etc.). */
export type EtlStage = "download" | "parse" | "insert" | "swap" | "done";
export interface EtlRun {
    id?: number;
    startedAt: Date;
    finishedAt?: Date;
    status: "running" | "success" | "failed";
    maxmindRecords?: number;
    ip2regionRecords?: number;
    dbipRecords?: number;
    mergedRecords?: number;
    errorMessage?: string;
    maxmindBuiltAt?: Date;
    ip2regionBuiltAt?: Date;
    dbipBuiltAt?: Date;
    /** Bytes downloaded so far across all in-flight downloads (sum). */
    downloadBytesDone?: number;
    /** Sum of expected sizes (Content-Length where known, otherwise
     *  bytes-done-so-far). 0 means "unknown total" and the UI renders
     *  an indeterminate bar instead of a percentage. */
    downloadBytesTotal?: number;
    /** Rows successfully inserted (or updated via ON DUPLICATE) across
     *  every source so far. */
    insertRowsDone?: number;
    /** Expected row count: total rows in source CSVs after parse. We
     *  fill this lazily so the bar starts moving from second zero
     *  instead of waiting for the full parse to complete. */
    insertRowsTotal?: number;
    currentStage?: EtlStage;
    progressUpdatedAt?: Date;
}
/** Snapshot passed from the pipeline to the admin UI via htmx polling.
 *  Cheap to JSON-serialise and stable across schema changes (anything
 *  new goes through EtlRun, not this). */
export interface EtlRunProgress {
    runId: number;
    status: "running" | "success" | "failed";
    currentStage: EtlStage | null;
    downloadBytesDone: number;
    downloadBytesTotal: number;
    insertRowsDone: number;
    insertRowsTotal: number;
    progressUpdatedAt: string | null;
    errorMessage: string | null;
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
export type Role = "user" | "admin";
export type QueryStatus = "hit" | "miss" | "invalid";
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
    createdAt: Date;
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
