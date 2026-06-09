// RateLimiter DurableObject: per-IP rate limiting with in-memory counters.
//
// Why a DO instead of KV: the old KV path did reads + writes per request across
// the tiers. KV writes are $5/M (1k/day free) and were the dominant ongoing KV
// cost. A DO holds the counters in memory and bumps them for ~$0.15/M requests
// -- ~100x cheaper -- with no per-request storage write.
//
// One DO instance per client IP via idFromName(hashIp(ip)) so each IP's
// counters live in their own object. In-memory is intentional: a DO eviction
// just resets a counter, which fails OPEN (lets a request through). That is
// acceptable for abuse mitigation -- we never want the limiter to take the API
// down, and an evicted counter only briefly under-counts.
//
// Hybrid metering: the per-second tier is a request burst guard (charged 1 per
// request); the per-day tier is a cost budget charged by ELEMENT count
// (origins × destinations). The caller passes the element count in the check
// request and evaluateTiers applies the right per-tier cost.
//
// The windowing/decision math is the shared pure logic from ratelimit.ts
// (computeTiers + evaluateTiers), so the DO and any other backend produce a
// byte-identical RateLimitResult and the X-RateLimit-* headers are unchanged.

import type { RateLimitResult, RateLimitConfig, TierName } from "./ratelimit.ts";
import { readLimitsFromEnv, computeTiers, evaluateTiers } from "./ratelimit.ts";

// In-memory counter for a single tier: the window bucket it belongs to and the
// number of requests counted in it. When the live bucket advances past `bucket`
// the count is stale and treated as 0 (the window rolled).
interface Counter {
  bucket: number;
  count: number;
}

interface RateLimiterEnv {
  [k: string]: unknown;
}

export class RateLimiter {
  // One counter per tier name, kept across requests for the life of this DO
  // instance. Not persisted to storage -- see the file header on fail-open.
  private counters: Map<TierName, Counter> = new Map();
  private env: RateLimiterEnv;

  constructor(_state: DurableObjectState, env: RateLimiterEnv) {
    this.env = env;
  }

  /**
   * Pure-ish core: given the active tiers for `now` and this request's element
   * count, read each tier's in-memory counter (resetting it if its window
   * rolled), run the shared decision logic, and persist the post-charge counts
   * back into memory when the request is allowed. The per-second tier is charged
   * 1; the per-day tier is charged `elements`. Exposed as a method (not just
   * fetch) so the windowing/counter behavior is unit-testable without a Request.
   */
  check(cfg: RateLimitConfig, now: number, elements: number): RateLimitResult {
    const tiers = computeTiers(cfg, now);

    // Read the used count for each tier from memory. A counter whose stored
    // bucket differs from the current bucket means that window has rolled, so
    // its prior count no longer applies -> used = 0.
    const used = tiers.map(t => {
      const c = this.counters.get(t.name);
      return c && c.bucket === t.bucket ? c.count : 0;
    });

    const { result, newCounts } = evaluateTiers(tiers, used, now, elements);

    // Only persist when the request was allowed (evaluateTiers returns the
    // post-charge counts then). On a block, counts are unchanged.
    if (result.ok) {
      tiers.forEach((t, i) => {
        this.counters.set(t.name, { bucket: t.bucket, count: newCounts[i] });
      });
    }
    return result;
  }

  /**
   * RPC entrypoint. The Worker calls stub.fetch(...) with the request body:
   *   { now?: number, elements?: number }
   *     now      -- optional epoch seconds; defaults to the DO's clock
   *     elements -- element count (origins × destinations) to charge the per-day
   *                 budget; defaults to 1. The per-second tier is always +1.
   * Limits come from this DO's own env (RL_PER_SEC / RL_ELEMENTS_PER_DAY, the
   * latter falling back to legacy RL_PER_DAY), so the Worker doesn't forward
   * them. Returns the RateLimitResult as JSON.
   */
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname !== "/check") {
      return new Response("Not Found", { status: 404 });
    }
    let body: { now?: number; elements?: number } = {};
    try {
      body = (await req.json()) as { now?: number; elements?: number };
    } catch {
      // Empty/invalid body -> use defaults (now from the clock, elements=1).
      body = {};
    }
    const cfg = readLimitsFromEnv(this.env);
    const now = typeof body.now === "number" ? body.now : Math.floor(Date.now() / 1000);
    const elements = typeof body.elements === "number" && body.elements >= 0 ? body.elements : 1;
    const result = this.check(cfg, now, elements);
    return Response.json(result);
  }
}
