// SPDX-License-Identifier: MIT
// The random-IP ingest rotates through the providers instead of asking all
// of them about every address.
//
// The queue-driven backfill wants several opinions per IP — that is what
// the vote is for. Random generation is different: the address is picked
// to widen coverage, and one confident answer is enough to write a row
// (see majority.ts). Asking four providers about forty random addresses an
// hour spends four times the quota for the same number of rows, and it is
// exactly the burst that trips the free tiers.
//
// Rotation is by a shuffled cycle, not by Math.random() per IP: a random
// pick can miss a provider for a long time, while a shuffled cycle
// guarantees every source is used equally often.
import type { IpGeoProvider } from "./providers/types";

export interface RotationState {
  /** Providers left in the current cycle, in shuffled order. */
  queue: IpGeoProvider[];
}

/** A rotation that starts with a fresh shuffle. */
export function createRotation(providers: IpGeoProvider[]): RotationState {
  return { queue: [] };
}

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
export function nextProvider(
  state: RotationState,
  providers: IpGeoProvider[],
  shuffle: <T>(items: T[]) => T[] = defaultShuffle,
): { provider: IpGeoProvider | null; state: RotationState } {
  if (providers.length === 0) return { provider: null, state: { queue: [] } };

  let queue = state.queue;
  // A provider removed mid-run (disabled after a 429) must drop out of the
  // cycle rather than being handed out again.
  queue = queue.filter((p) => providers.some((live) => live.name === p.name));

  if (queue.length === 0) {
    queue = shuffle([...providers]);
  }

  const [provider, ...rest] = queue;
  return { provider: provider ?? null, state: { queue: rest } };
}

/** Fisher-Yates, on a copy. */
function defaultShuffle<T>(items: T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}
