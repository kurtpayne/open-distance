// Per-IP rate limiting via the existing CACHE KV namespace.
//
// **Privacy**: the IP itself is never stored. The KV key is a truncated
// SHA-256 of `RL_SALT + ip + bucket_id`, so:
//   - the stored key reveals only "someone hit at most N times in window X",
//     not which IP
//   - the per-window bucket_id means tomorrow's keys can't be cross-referenced
//     with today's
//   - rotating RL_SALT additionally severs all linkability across the rotation
// Combined with the short TTLs, the only data retained is "this hash hit N
// times during this short window" -- no IPs, no addresses.
//
// Three tiers (per-second / per-hour / per-day); a request is blocked when
// any tier is over its limit. Defaults 5/sec, 100/hour, 1000/day per IP.
// Tunable via env vars RL_PER_SEC / RL_PER_HOUR / RL_PER_DAY (0 disables).
//
// COST NOTE: these defaults are deliberately conservative to cap KV/D1 usage.
// Each request costs ~3 KV writes (rate-limit increments) + up to ~100 KV
// writes (leg cache, cold) + up to ~49 D1 reads (geocode shard fan-out). KV
// writes bill at $5/M (only 1k/day free) and are the real cost lever, so the
// per-IP ceiling bounds what a single client can run up. Per-IP limits do NOT
// cap GLOBAL spend — pair these with a Cloudflare billing alert. Raise via env
// for a trusted/private fork.
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

// SHA-256 a salted (ip, bucket) tuple to a short hex string. The IP itself is
// never stored. 16 hex chars = 64 bits of key entropy, plenty for a small
// bucket counter; collisions just mean different IPs share a counter (which
// only over-counts the limit, never under-counts).
async function ipBucketKey(salt: string, ip: string, tier: string, bucket: number): Promise<string> {
  const data = new TextEncoder().encode(`${salt}|${tier}|${ip}|${bucket}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const hex = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
  return `rl:${tier}:${hex.slice(0, 16)}`;
}

function tierResetIn(name: TierName, now: number): number {
  if (name === "sec") return 1;
  if (name === "hour") return 3600 - (now % 3600);
  return 86400 - (now % 86400);
}

export async function checkRateLimit(
  kv: KVNamespace,
  ip: string,
  cfg: RateLimitConfig = DEFAULT_LIMITS,
  salt = "od-default-salt-rotate-me",
): Promise<RateLimitResult> {
  const now = Math.floor(Date.now() / 1000);
  // KV expirationTtl minimum is 60 seconds. The per-sec bucket key already
  // rotates every second via `bucket: now`, so a longer TTL only leaves stale
  // counter rows in KV for an extra ~minute -- they don't affect counting.
  const tiers = [
    { name: "sec"  as TierName, bucket: now,                     limit: cfg.perSec,  ttl: 60    },
    { name: "hour" as TierName, bucket: Math.floor(now / 3600),  limit: cfg.perHour, ttl: 3700  },
    { name: "day"  as TierName, bucket: Math.floor(now / 86400), limit: cfg.perDay,  ttl: 90000 },
  ].filter(t => t.limit > 0);
  if (tiers.length === 0) return { ok: true, tiers: [] };

  const keys = await Promise.all(tiers.map(t => ipBucketKey(salt, ip, t.name, t.bucket)));
  const counts = await Promise.all(keys.map(k => kv.get(k, "text")));
  const used = counts.map(c => parseInt(c || "0", 10));

  // Check all tiers, return the first one that's blown.
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
        ok: false,
        tiers: states,
        retryAfter: tierResetIn(tiers[i].name, now),
        limitName: tiers[i].name,
        currentCount: used[i],
      };
    }
  }

  // Increment all tiers. KV is eventually consistent across colos -- a burst
  // hitting multiple CF colos at once may slightly exceed the per-second
  // limit, but the per-hour and per-day buckets are accurate enough for
  // abuse mitigation.
  await Promise.all(tiers.map((t, i) => kv.put(keys[i], String(used[i] + 1), { expirationTtl: t.ttl })));

  // After incrementing, `remaining` is computed against the new used count.
  const states: TierState[] = tiers.map((t, j) => ({
    name: t.name,
    limit: t.limit,
    used: used[j] + 1,
    remaining: Math.max(0, t.limit - (used[j] + 1)),
    resetIn: tierResetIn(t.name, now),
  }));
  return { ok: true, tiers: states };
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
      `No paid tier -- self-host with your own limits: https://github.com/kurtpayne/open-distance`,
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
