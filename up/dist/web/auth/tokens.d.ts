export declare function generateToken(bytes?: number): string;
export declare function hashToken(plain: string): string;
export declare function generateCsrf(): string;
export declare function verifyCsrf(presented: string, expected: string, issuedAt: number, ttlMs: number): boolean;
export declare function generateApiKey(): string;
/** HMAC-bind a CSRF nonce to the server-side secret. The nonce travels
 *  in the cookie (readable by JS) AND in the form body; the HMAC
 *  lives in a SECOND cookie that's httpOnly + secure. On verify,
 *  recompute the HMAC and compare it to the bind cookie.
 *
 *  This is the "double submit cookie" pattern hardened against XSS
 *  exfiltration of the readable nonce (because the nonce alone is
 *  useless without the httpOnly HMAC). Rotating CSRF_SECRET
 *  invalidates all outstanding CSRF tokens; the cookie TTL (4h) caps
 *  the blast radius of a leaked nonce. */
export declare function signCsrfBinding(secret: string, nonce: string): string;
