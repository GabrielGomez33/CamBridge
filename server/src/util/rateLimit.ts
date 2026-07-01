// Tiny in-memory fixed-window rate limiter. Returns a function that reports
// whether `key` (an IP, user id, …) is still within `limit` per `windowMs`.
// Swap for Redis in a multi-instance deployment.
export function makeRateLimiter(limit: number, windowMs: number) {
  const hits = new Map<string, { count: number; reset: number }>();

  const allow = (key: string): boolean => {
    const now = Date.now();
    const rec = hits.get(key);
    if (!rec || now > rec.reset) {
      hits.set(key, { count: 1, reset: now + windowMs });
      return true;
    }
    rec.count++;
    return rec.count <= limit;
  };

  // Occasionally drop expired buckets so the map can't grow unbounded.
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [k, rec] of hits) if (now > rec.reset) hits.delete(k);
  }, windowMs);
  sweep.unref?.();

  return allow;
}
