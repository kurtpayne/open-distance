// Per-IP rate limiting. Shared types + pure decision logic live here; the
// actual counters live in the RateLimiter DurableObject (src/ratelimiter_do.ts)
// -- one DO instance per client IP. DO bumps cost ~$0.15/M requests vs KV
// writes at $5/M, so the same 3-tier check is ~100x cheaper.
//
// **Privacy**: the IP itself is never stored. The DO is addressed by a salted
// SHA-256 of the IP (see hashIp), so:
//   - the DO name reveals only "some client hit N times in window X", not which
//     IP
//   - rotating RL_SALT severs all linkability across the rotation
// Counters are held in DO memory keyed by the current window bucket; nothing
// durable is written per request, and a DO eviction just resets a counter
// (fails open) -- acceptable for abuse mitigation.
//
// Three tiers (per-second / per-hour / per-day); a request is blocked when
// any tier is over its limit. Defaults 5/sec, 100/hour, 1000/day per IP.
// Tunable via env vars RL_PER_SEC / RL_PER_HOUR / RL_PER_DAY (0 disables).
//
// COST NOTE: defaults are conservative to bound per-IP usage. Counters now live
// in a Durable Object (~$0.15/M requests) instead of KV (was 3 writes/req at
// $5/M). Per-IP limits don't cap GLOBAL spend — pair with a Cloudflare billing
// alert. Raise via env for a trusted/private fork.
//
// Every response (both allowed and 429) carries headers:
//   X-RateLimit-Limit-{Second,Hour,Day}      = configured limit for that tier
//   X-RateLimit-Remaining-{Second,Hour,Day}  = requests left in the current window
//   X-RateLimit-Reset-{Second,Hour,Day}      = seconds until that window rolls
// plus the IETF draft single-policy header set:
//   RateLimit-Limit / RateLimit-Remaining / RateLimit-Reset
// reflecting whichever tier is currently the tightest constraint.

export interface RateLimitConfig {
  perSec: number;
  perHour: number;
  perDay: number;
}

export const DEFAULT_LIMITS: RateLimitConfig = {
  perSec: 5,
  perHour: 100,
  perDay: 1_000,
};

export type TierName = "sec" | "hour" | "day";

export interface TierState {
  name: TierName;
  limit: number;
  // Requests already used in the current window (BEFORE this request consumed a slot).
  used: number;
  // Requests left AFTER this request is counted. Floored at 0.
  remaining: number;
  // Seconds until the current window rolls and the counter resets.
  resetIn: number;
}

export interface RateLimitResult {
  ok: boolean;
  tiers: TierState[];
  // Set when ok=false:
  retryAfter?: number;
  limitName?: TierName;
  currentCount?: number;
}

export function readLimitsFromEnv(env: { [k: string]: unknown }): RateLimitConfig {
  return {
    perSec: Number(env.RL_PER_SEC ?? DEFAULT_LIMITS.perSec),
    perHour: Number(env.RL_PER_HOUR ?? DEFAULT_LIMITS.perHour),
    perDay: Number(env.RL_PER_DAY ?? DEFAULT_LIMITS.perDay),
  };
}

// Salted SHA-256 of an IP -> short hex id, with NO per-tier/per-bucket
// component. Used by the DurableObject path as the DO instance name so each
// IP's counters live in their own DO. Like ipBucketKey, the raw IP is never
// stored; collisions only over-count (share a DO), never under-count.
export async function hashIp(salt: string, ip: string): Promise<string> {
  const data = new TextEncoder().encode(`${salt}|do|${ip}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

export function tierResetIn(name: TierName, now: number): number {
  if (name === "sec") return 1;
  if (name === "hour") return 3600 - (now % 3600);
  return 86400 - (now % 86400);
}

// A single tier's configuration for the current instant: which window bucket it
// falls in and its limit. `bucket` rolls when the window advances (sec=now,
// hour=floor(now/3600), day=floor(now/86400)) -- when it changes, that tier's
// counter resets.
export interface TierSpec {
  name: TierName;
  bucket: number;
  limit: number;
}

// Compute the active tiers (those with limit > 0) for a given instant. Shared
// by every rate-limit backend so the windowing/bucket math lives in exactly
// one place.
export function computeTiers(cfg: RateLimitConfig, now: number): TierSpec[] {
  return [
    { name: "sec"  as TierName, bucket: now,                    limit: cfg.perSec  },
    { name: "hour" as TierName, bucket: Math.floor(now / 3600), limit: cfg.perHour },
    { name: "day"  as TierName, bucket: Math.floor(now / 86400), limit: cfg.perDay },
  ].filter(t => t.limit > 0);
}

// Pure rate-limit decision given the tiers and the counts already used in each
// tier's current window (BEFORE this request). Returns the RateLimitResult and,
// when allowed, the post-increment counts the caller should persist. No I/O --
// both the KV path and the DurableObject call this so the contract is identical.
export function evaluateTiers(
  tiers: TierSpec[],
  used: number[],
  now: number,
): { result: RateLimitResult; newCounts: number[] } {
  if (tiers.length === 0) {
    return { result: { ok: true, tiers: [] }, newCounts: [] };
  }

  // Check all tiers; the first one already at/over its limit blocks the request.
  for (let i = 0; i < tiers.length; i++) {
    if (used[i] >= tiers[i].limit) {
      const states: TierState[] = tiers.map((t, j) => ({
        name: t.name,
        limit: t.limit,
        used: used[j],
        remaining: Math.max(0, t.limit - used[j]),
        resetIn: tierResetIn(t.name, now),
      }));
      return {
        result: {
          ok: false,
          tiers: states,
          retryAfter: tierResetIn(tiers[i].name, now),
          limitName: tiers[i].name,
          currentCount: used[i],
        },
        newCounts: used.slice(),
      };
    }
  }

  // Allowed: count this request against every tier.
  const newCounts = used.map(u => u + 1);
  const states: TierState[] = tiers.map((t, j) => ({
    name: t.name,
    limit: t.limit,
    used: newCounts[j],
    remaining: Math.max(0, t.limit - newCounts[j]),
    resetIn: tierResetIn(t.name, now),
  }));
  return { result: { ok: true, tiers: states }, newCounts };
}


// Build the X-RateLimit-* and IETF RateLimit-* headers for any response.
export function rateLimitHeaders(tiers: TierState[]): Record<string, string> {
  const h: Record<string, string> = {};
  for (const t of tiers) {
    const k = t.name === "sec" ? "second" : t.name === "hour" ? "hour" : "day";
    h[`x-ratelimit-limit-${k}`] = String(t.limit);
    h[`x-ratelimit-remaining-${k}`] = String(t.remaining);
    h[`x-ratelimit-reset-${k}`] = String(t.resetIn);
  }
  // IETF draft RateLimit headers: surface the tier with the smallest remaining
  // count so a single-header consumer sees the binding constraint.
  if (tiers.length > 0) {
    const tightest = [...tiers].sort((a, b) => a.remaining - b.remaining)[0];
    h["ratelimit-limit"] = String(tightest.limit);
    h["ratelimit-remaining"] = String(tightest.remaining);
    h["ratelimit-reset"] = String(tightest.resetIn);
  }
  return h;
}

export function rateLimitResponse(result: RateLimitResult, cfg: RateLimitConfig): Response {
  const tierLimit = result.limitName === "sec" ? cfg.perSec
                  : result.limitName === "hour" ? cfg.perHour
                  : cfg.perDay;
  const tierWindow = result.limitName === "sec" ? "second"
                   : result.limitName === "hour" ? "hour"
                   : "day";
  const body = {
    status: "OVER_QUERY_LIMIT",
    error_message:
      `Rate limit exceeded: ${tierLimit} requests per ${tierWindow} per IP. ` +
      `Try again in ${result.retryAfter ?? 60} second(s). ` +
      `No paid tier -- self-host with your own limits: https://github.com/kurtpayne/open-distance. ` +
      `Contact hello@open-distance.com for custom solutions.`,
    rows: [],
    origin_addresses: [],
    destination_addresses: [],
  };
  return new Response(JSON.stringify(body), {
    status: 429,
    headers: {
      "content-type": "application/json; charset=UTF-8",
      "retry-after": String(result.retryAfter ?? 60),
      "cache-control": "no-store",
      "x-ratelimit-tier": result.limitName ?? "",
      "x-ratelimit-current": String(result.currentCount ?? 0),
      ...rateLimitHeaders(result.tiers),
    },
  });
}
