/**
 * True when the requester is still inside the cooldown window.
 *
 * `requesterId` identifies the caller — an IP address.
 */
export declare function isResendOnCooldown(requesterId: string, cooldownMs: number): boolean;
/**
 * Start the cooldown for a requester.
 */
export declare function startResendCooldown(requesterId: string, cooldownMs: number): void;
/**
 * Clear all state. Test-only.
 */
export declare function _resetForTests(): void;
