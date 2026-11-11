import "dotenv/config";
export interface WebConfig {
    baseUrl: string;
    cookieDomain: string;
    cookieSecure: boolean;
    sessionTtlHours: number;
    sessionSecret: string;
    csrfSecret: string;
}
export interface SmtpConfig {
    host: string;
    port: number;
    secure: boolean;
    user: string;
    pass: string;
    from: string;
}
export interface SecurityConfig {
    loginMaxAttempts: number;
    loginLockoutMinutes: number;
    signupRatePerIpPerHour: number;
    verifyResendCooldownSeconds: number;
}
export interface AdminBootstrap {
    email: string;
    password: string;
}
export interface AppConfig {
    db: {
        host: string;
        port: number;
        user: string;
        password: string;
        database: string;
        poolSize: number;
    };
    maxmind: {
        licenseKey?: string;
        editions: string[];
    };
    api: {
        port: number;
        rateLimit: number;
    };
    etl: {
        schedule: string;
        timezone: string;
        dataDir: string;
    };
    web: WebConfig;
    smtp: SmtpConfig;
    security: SecurityConfig;
    admin: AdminBootstrap;
}
export declare function loadConfig(): AppConfig;
export declare function redactSecret(value: string): string;
export declare function configSummary(cfg: AppConfig): string;
