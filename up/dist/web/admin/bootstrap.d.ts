import type { Pool } from "mysql2/promise";
export interface BootstrapAdminOpts {
    email: string;
    password: string;
    displayName?: string;
}
export declare function bootstrapAdmin(pool: Pool, opts: BootstrapAdminOpts): Promise<{
    id: number;
}>;
