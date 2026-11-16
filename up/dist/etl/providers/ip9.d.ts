import type { IpGeoProvider, IpGeoLookupResult } from "./types";
export declare class Ip9Provider implements IpGeoProvider {
    private readonly opts;
    readonly name = "ip9";
    constructor(opts?: {
        endpoint?: string;
        timeoutMs?: number;
    });
    lookup(ip: string): Promise<IpGeoLookupResult>;
}
