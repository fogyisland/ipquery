import type { IpGeoProvider } from "./providers/types";
export interface RotationState {
    /** Providers left in the current cycle, in shuffled order. */
    queue: IpGeoProvider[];
}
/** A rotation that starts with a fresh shuffle. */
export declare function createRotation(providers: IpGeoProvider[]): RotationState;
/**
 * Take the next provider for one IP.
 *
 * Returns the provider and the state to carry into the next call. When the
 * cycle empties it is refilled from `providers` in a fresh shuffle, so over
 * enough IPs every provider is chosen the same number of times (within one
 * cycle's rounding).
 *
 * `shuffle` is injectable so tests can make the order deterministic.
 */
export declare function nextProvider(state: RotationState, providers: IpGeoProvider[], shuffle?: <T>(items: T[]) => T[]): {
    provider: IpGeoProvider | null;
    state: RotationState;
};
