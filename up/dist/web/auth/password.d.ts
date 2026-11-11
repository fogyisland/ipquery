export declare function hashPassword(plain: string): Promise<string>;
export declare function verifyPassword(hash: string, plain: string): Promise<boolean>;
export type PasswordValidation = {
    ok: true;
} | {
    ok: false;
    reason: "too_short" | "no_digit" | "no_letter";
};
export declare function validatePassword(plain: string): PasswordValidation;
