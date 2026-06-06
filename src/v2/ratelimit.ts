// Per-IP rate limiting via the existing CACHE KV namespace. Three tiers
// (per-second / per-hour / per-day); a request is blocked when any tier is
// over its limit. Each tier is one KV bucket key per IP per window, with a
// short TTL so old buckets self-evict.
//
// Defaults: 25/sec, 500/hour, 10000/day per IP.
// Tunable via env vars RL_PER_SEC / RL_PER_HOUR / RL_PER_DAY.
// Set any to 0 to disable that tier.
//
// Cost notes:
//   - 1 KV read per tier + 1 KV write per tier on every limited request.
//   - Workers Paid ($5/mo) includes 10M KV reads + 1M writes/month.
//   - On the free plan (100k KV reads + 1k writes/day), traffic naturally caps
//     well below the rate limits anyway -- KV is the bottleneck before the
//     limits themselves trigger.
//   - For very high traffic, switch to Cloudflare's WAF Rate Limiting rules
//     (config in the dashboard, no per-request KV cost). KV-based is the
//     fork-and-deploy default because it works on every plan with no extra
//     dashboard setup.

export interface RateLimitConfig {
  perSec: number;
  perHour: number;
  perDay: number;
}

export const DEFAULT_LIMITS: RateLimitConfig = {
  perSec: 25,
  perHour: 500,
  perDay: 10_000,
};

export interface RateLimitResult {
  ok: boolean;
  retryAfter?: number;
  limitName?: "sec" | "hour" | "day";
  currentCount?: number;
}

export function readLimitsFromEnv(env: { [k: string]: unknown }): RateLimitConfig {
  return {
    perSec: Number(env.RL_PER_SEC ?? DEFAULT_LIMITS.perSec),
    perHour: Number(env.RL_PER_HOUR ?? DEFAULT_LIMITS.perHour),
    perDay: Number(env.RL_PER_DAY ?? DEFAULT_LIMITS.perDay),
  };
}

export async function checkRateLimit(
  kv: KVNamespace,
  ip: string,
  cfg: RateLimitConfig = DEFAULT_LIMITS,
): Promise<RateLimitResult> {
  const now = Math.floor(Date.now() / 1000);
  const tiers = [
    { name: "sec" as const,  bucket: now,                 limit: cfg.perSec,  ttl: 5     },
    { name: "hour" as const, bucket: Math.floor(now / 3600),  limit: cfg.perHour, ttl: 3700  },
    { name: "day" as const,  bucket: Math.floor(now / 86400), limit: cfg.perDay,  ttl: 90000 },
  ].filter(t => t.limit > 0);
  if (tiers.length === 0) return { ok: true };

  const keys = tiers.map(t => `rl:${t.name}:${ip}:${t.bucket}`);
  const counts = await Promise.all(keys.map(k => kv.get(k, "text")));

  // Check all tiers, return the first one that's blown.
  for (let i = 0; i < tiers.length; i++) {
    const c = parseInt(counts[i] || "0", 10);
    if (c >= tiers[i].limit) {
      const retryAfter = tiers[i].name === "sec" ? 1
                       : tiers[i].name === "hour" ? 3600
                       : 86400;
      return { ok: false, retryAfter, limitName: tiers[i].name, currentCount: c };
    }
  }

  // Increment all tiers. KV is eventually consistent across colos -- a burst
  // hitting multiple CF colos at once may slightly exceed the per-second
  // limit, but the per-hour and per-day buckets are accurate enough for
  // abuse mitigation.
  await Promise.all(tiers.map((t, i) => {
    const c = parseInt(counts[i] || "0", 10);
    return kv.put(keys[i], String(c + 1), { expirationTtl: t.ttl });
  }));

  return { ok: true };
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
      `Self-host with your own limits: https://github.com/kurtpayne/hhapi`,
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
    },
  });
}
