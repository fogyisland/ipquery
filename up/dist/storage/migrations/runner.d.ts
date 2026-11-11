import * as mysql from "mysql2/promise";
export declare function getAppliedVersions(pool: mysql.Pool): Promise<Set<string>>;
export interface MigrationResult {
    applied: string[];
    skipped: string[];
}
export declare function runMigrations(pool: mysql.Pool): Promise<MigrationResult>;
export declare function migrationStatus(pool: mysql.Pool): Promise<{
    applied: string[];
    pending: string[];
}>;
export declare function listMigrationFiles(): Promise<string[]>;
