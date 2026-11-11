import type { Pool } from "mysql2/promise";
import { type AuditLogEntry } from "../../storage/auditLog";
import { type DailyBucket } from "../../storage/queryLog";
export interface Overview {
    generatedAt: Date;
    etl: {
        lastRun: {
            id: number;
            startedAt: Date;
            finishedAt: Date | null;
            status: string;
            mergedRecords: number;
        } | null;
        lastSuccessAt: Date | null;
        runsToday: number;
    };
    db: {
        ipRanges: number;
        queryLogTotal: number;
        users: {
            total: number;
            verified: number;
            disabled: number;
        };
        apiKeys: {
            total: number;
            active: number;
        };
    };
    queries24h: {
        hit: number;
        miss: number;
        invalid: number;
        total: number;
        hitRate: number;
    };
    last7Days: DailyBucket[];
    recentActivity: AuditLogEntry[];
}
export declare function getOverview(pool: Pool): Promise<Overview>;
