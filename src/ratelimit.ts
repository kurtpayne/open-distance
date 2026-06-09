// Per-IP rate limiting. Shared types + pure decision logic live here; the
// actual counters live in the RateLimiter DurableObject (src/ratelimiter_do.ts)
// -- one DO instance per client IP. DO bumps cost ~$0.15/M requests vs KV
// writes at $5/M, so the same tier check is ~100x cheaper.
//
// **Hybrid metering (burst in requests, cost in elements):** the per-second
// tier is a pure burst/DoS guard and is charged 1 per request. The per-day tier
// is a COST budget measured in ELEMENTS (= origins × destinations), so a 5x5
// matrix request charges 25 to the daily budget but still only 1 to the per-
// second burst. This makes the daily/global caps track actual serving cost (an
// element is one origin->destination route solve) rather than raw request count.
//
// **Privacy**: the IP itself is never stored. The DO is addressed by a salted
// SHA-256 of the IP (see hashIp), so:
//   - the DO name reveals only "some client used N in window X", not which IP
//   - rotating RL_SALT severs all linkability across the rotation
// Counters are held in DO memory keyed by the current window bucket; nothing
// durable is written per request, and a DO eviction just resets a counter
// (fails open) -- acceptable for abuse mitigation.
//
// Two tiers (per-second requests / per-day elements); a request is blocked when
// either tier is already at/over its limit. Defaults 5 requests/sec, 2500
// elements/day per IP. Tunable via env vars RL_PER_SEC / RL_ELEMENTS_PER_DAY
// (0 disables a tier). RL_ELEMENTS_PER_DAY falls back to the legacy RL_PER_DAY
// for existing deployments/forks.
//
// COST NOTE: defaults are conservative to bound per-IP usage. Counters now live
// in a Durable Object (~$0.15/M requests) instead of KV (was writes/req at
// $5/M). Per-IP limits don't cap GLOBAL spend -- pair with a Cloudflare billing
// alert. Raise via env for a trusted/private fork.
//
// Every response (both allowed and 429) carries headers:
//   X-RateLimit-Limit-{Second,Day}      = configured limit for that tier
//   X-RateLimit-Remaining-{Second,Day}  = budget left in the current window
//                                         (requests for Second, ELEMENTS for Day)
//   X-RateLimit-Reset-{Second,Day}      = seconds until that window rolls
// plus the IETF draft single-policy header set:
//   RateLimit-Limit / RateLimit-Remaining / RateLimit-Reset
// reflecting whichever tier is currently the tightest constraint.

export interface RateLimitConfig {
  // Per-IP requests/second (burst guard; charged 1 per request).
  perSec: number;
  // Per-IP elements/day (cost budget; charged `elements` per request).
  perDay: number;
}

export const DEFAULT_LIMITS: RateLimitConfig = {
  perSec: 5,
  perDay: 2_500,
};

export type TierName = "sec" | "day";

export interface TierState {
  name: TierName;
  limit: number;
  // Amount already used in the current window (BEFORE this request was charged).
  // Requests for the "sec" tier; ELEMENTS for the "day" tier.
  used: number;
  // Budget left AFTER this request is charged. Floored at 0.
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

// Read the per-IP limits from env.
//   perSec -> RL_PER_SEC (requests/sec, burst)
//   perDay -> RL_ELEMENTS_PER_DAY (elements/day), falling back to the legacy
//             RL_PER_DAY when the element-named key is absent so existing
//             deployments/forks keep working.
export function readLimitsFromEnv(env: { [k: string]: unknown }): RateLimitConfig {
  const elementsPerDay = env.RL_ELEMENTS_PER_DAY ?? env.RL_PER_DAY;
  return {
    perSec: Number(env.RL_PER_SEC ?? DEFAULT_LIMITS.perSec),
    perDay: Number(elementsPerDay ?? DEFAULT_LIMITS.perDay),
  };
}

// Salted SHA-256 of an IP -> short hex id, with NO per-tier/per-bucket
// component. Used by the DurableObject path as the DO instance name so each
// IP's counters live in their own DO. The raw IP is never stored; collisions
// only over-count (share a DO), never under-count.
export async function hashIp(salt: string, ip: string): Promise<string> {
  const data = new TextEncoder().encode(`${salt}|do|${ip}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

export function tierResetIn(name: TierName, now: number): number {
  if (name === "sec") return 1;
  return 86400 - (now % 86400);
}

// A single tier's configuration for the current instant: which window bucket it
// falls in and its limit. `bucket` rolls when the window advances (sec=now,
// day=floor(now/86400)) -- when it changes, that tier's counter resets.
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
    { name: "sec" as TierName, bucket: now,                     limit: cfg.perSec },
    { name: "day" as TierName, bucket: Math.floor(now / 86400), limit: cfg.perDay },
  ].filter(t => t.limit > 0);
}

// Per-tier charge for a request. The per-second tier is a request-rate burst
// guard (always +1); the per-day tier is a cost budget charged by element count
// (origins × destinations). A request that doesn't carry a meaningful element
// count (malformed params -> elements=0) charges nothing to the day tier but
// still consumes a per-second slot.
function tierCost(name: TierName, elements: number): number {
  return name === "sec" ? 1 : elements;
}

// Pure rate-limit decision given the tiers, the amounts already used in each
// tier's current window (BEFORE this request), and the element count for this
// request. Returns the RateLimitResult and, when admitted, the post-charge
// counts the caller should persist. No I/O -- the DurableObject calls this so
// the contract is identical and testable.
//
// Admit-then-charge: a tier blocks only when it is ALREADY at/over its limit
// (used >= limit). A request that fits is admitted and charged its full cost,
// so the boundary request may overshoot the daily budget by up to `elements`-1
// (capped at MAX_ELEMENTS-1, so < 25). That's intentional and matches the prior
// admit-then-increment semantics.
export function evaluateTiers(
  tiers: TierSpec[],
  used: number[],
  now: number,
  elements: number,
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

  // Admitted: charge this request against every tier (1 to sec, `elements` to day).
  const newCounts = tiers.map((t, j) => used[j] + tierCost(t.name, elements));
  const states: TierState[] = tiers.map((t, j) => ({
    name: t.name,
    limit: t.limit,
    used: newCounts[j],
    remaining: Math.max(0, t.limit - newCounts[j]),
    resetIn: tierResetIn(t.name, now),
  }));
  return { result: { ok: true, tiers: states }, newCounts };
}


// Build the X-RateLimit-* and IETF RateLimit-* headers for any response. For the
// day tier the limit/remaining values are ELEMENT budgets, not request counts.
export function rateLimitHeaders(tiers: TierState[]): Record<string, string> {
  const h: Record<string, string> = {};
  for (const t of tiers) {
    const k = t.name === "sec" ? "second" : "day";
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

// `cta` is the contact call-to-action sentence (built via contactCta in
// src/config.ts) appended to the error message. Pass "" to omit it -- callers
// read CONTACT_EMAIL from env so the contact address is config, not code.
//
// The per-second tier reports a requests/second budget; the per-day tier now
// reports an ELEMENTS/day budget (elements = origins × destinations).
export function rateLimitResponse(result: RateLimitResult, cfg: RateLimitConfig, cta = ""): Response {
  const isSec = result.limitName === "sec";
  const tierLimit = isSec ? cfg.perSec : cfg.perDay;
  const unit = isSec ? "requests per second" : "elements per day";
  const body = {
    status: "OVER_QUERY_LIMIT",
    error_message:
      `Rate limit exceeded: Per-IP limit ${tierLimit} ${unit}` +
      `${isSec ? "" : " (elements = origins × destinations)"}. ` +
      `Try again in ${result.retryAfter ?? 60} second(s). ` +
      `No paid tier -- self-host with your own limits: https://github.com/kurtpayne/open-distance.` +
      cta,
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
