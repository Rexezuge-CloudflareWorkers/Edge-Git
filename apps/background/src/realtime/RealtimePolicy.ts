/**
 * Pure realtime socket policy (Otter pure-helper pattern).
 *
 * Extracted from `RealtimeWorker` so rate-limit and eviction rules are
 * unit testable without Durable Object hibernation.
 */
function pruneFrameTimes(frameTimes: number[], now: number, windowMs = 60_000): number[] {
  return frameTimes.filter((time) => now - time < windowMs);
}

function shouldRateLimit(frameTimes: number[], now: number, limit: number, windowMs = 60_000): boolean {
  return pruneFrameTimes(frameTimes, now, windowMs).length >= limit;
}

interface EvictionCandidate {
  viewer: string;
}

// Anonymous sockets yield to authenticated viewers when a shard is full.
// Returns the index of the victim to evict, or -1 when no room can be made.
function pickEvictionCandidate(sockets: EvictionCandidate[], viewer: string, max: number): number {
  if (sockets.length < max) return -2;
  if (viewer !== 'anonymous') {
    const victim = sockets.findIndex((socket) => socket.viewer === 'anonymous');
    if (victim !== -1) return victim;
  }
  return -1;
}

export { pickEvictionCandidate, pruneFrameTimes, shouldRateLimit };
export type { EvictionCandidate };
