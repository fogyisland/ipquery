export interface SsrfCheckResult {
    ok: boolean;
    reason?: string;
}
export declare function assertSafeHttpUrl(rawUrl: string): Promise<SsrfCheckResult>;
