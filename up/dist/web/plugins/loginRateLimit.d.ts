export declare function recordLoginFailure(email: string, maxAttempts: number, lockoutMinutes: number): {
    locked: boolean;
    retryAfterSec: number;
};
export declare function recordLoginSuccess(email: string): void;
export declare function isLocked(email: string): {
    locked: boolean;
    retryAfterSec: number;
};
export declare function _resetForTests(): void;
