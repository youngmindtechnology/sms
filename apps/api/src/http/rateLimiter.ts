/**
 * Fixed-window rate limiter held in memory.
 *
 * Suitable for ONE API process (this MVP). With several instances behind a load
 * balancer each would count separately, so a shared store (for example the
 * database or Redis) would replace this class; callers only use check().
 * The per-account lockout in the database already holds across instances.
 */
export interface RateLimiterOptions {
  windowMs: number;
  limit: number;
  /** Safety valve so a flood of distinct keys cannot grow memory without bound. */
  maxKeys?: number;
}

export interface RateDecision {
  allowed: boolean;
  retryAfterSeconds: number;
}

export class RateLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();
  private readonly maxKeys: number;

  constructor(private readonly options: RateLimiterOptions) {
    this.maxKeys = options.maxKeys ?? 10_000;
  }

  check(key: string, now: number = Date.now()): RateDecision {
    let entry = this.hits.get(key);
    if (!entry || entry.resetAt <= now) {
      if (this.hits.size >= this.maxKeys) this.prune(now);
      entry = { count: 0, resetAt: now + this.options.windowMs };
      this.hits.set(key, entry);
    }
    entry.count += 1;
    const retryAfterSeconds = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
    return { allowed: entry.count <= this.options.limit, retryAfterSeconds };
  }

  private prune(now: number): void {
    for (const [key, entry] of this.hits) if (entry.resetAt <= now) this.hits.delete(key);
    // Still full of live entries: drop the oldest half rather than refuse service.
    if (this.hits.size >= this.maxKeys) {
      let drop = Math.ceil(this.hits.size / 2);
      for (const key of this.hits.keys()) {
        if (drop-- <= 0) break;
        this.hits.delete(key);
      }
    }
  }
}
