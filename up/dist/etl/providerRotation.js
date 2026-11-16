"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createRotation = createRotation;
exports.nextProvider = nextProvider;
/** A rotation that starts with a fresh shuffle. */
function createRotation(providers) {
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
function nextProvider(state, providers, shuffle = defaultShuffle) {
    if (providers.length === 0)
        return { provider: null, state: { queue: [] } };
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
function defaultShuffle(items) {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
}
//# sourceMappingURL=providerRotation.js.map