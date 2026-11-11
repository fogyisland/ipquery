import type { Pool } from "mysql2/promise";
import type { User, Role } from "../types";
export interface CreateUserInput {
    email: string;
    passwordHash: string;
    displayName: string;
    role?: Role;
}
export declare function createUser(pool: Pool, input: CreateUserInput): Promise<User>;
export declare function findUserByEmail(pool: Pool, email: string): Promise<User | null>;
export declare function findUserById(pool: Pool, id: number): Promise<User | null>;
export declare function getUserPasswordHash(pool: Pool, userId: number): Promise<string | null>;
export declare function markEmailVerified(pool: Pool, userId: number): Promise<void>;
export declare function setDisabled(pool: Pool, userId: number, disabled: boolean): Promise<void>;
export declare function updatePassword(pool: Pool, userId: number, newHash: string): Promise<void>;
export declare function updateDisplayName(pool: Pool, userId: number, name: string): Promise<void>;
export declare function updateEmail(pool: Pool, userId: number, email: string): Promise<void>;
export declare function setLastLogin(pool: Pool, userId: number): Promise<void>;
export declare function deleteUser(pool: Pool, userId: number): Promise<void>;
export declare function listUsers(pool: Pool, opts: {
    offset: number;
    limit: number;
    search?: string;
    role?: Role;
}): Promise<{
    rows: User[];
    total: number;
}>;
