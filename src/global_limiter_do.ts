// GlobalLimiter DurableObject: account-wide hard daily ELEMENT cap.
//
// Why: per-IP limits (src/ratelimiter_do.ts) bound how much any single client
// can do, but they do NOT bound total spend -- a thousand distinct IPs can each
// stay under the per-IP cap and still run the account's serving cost up. This
// DO is a single shared instance (callers address it via idFromName("global"))
// that counts every ADMITTED request's ELEMENTS (origins × destinations) against
// one global per-UTC-day budget and trips at GLOBAL_ELEMENTS_PER_DAY (default
// 25,000 elements), keeping total serving inside Cloudflare's free tier (~$5/mo).
// Metering by elements (not requests) makes the cap track actual serving cost --
// one element is one origin->destination route solve.
//
// In-memory only, same posture as the per-IP limiter: the counter lives in this
// DO's memory keyed by the current UTC-day bucket. A DO eviction resets the
// counter (fails OPEN -- briefly under-counts), which is acceptable: we never
// want a limiter fault to take the API down. No per-request storage write.
//
// Contract: callers POST to the DO with { now?, elements? } and get back
//   { ok, used, limit, resetIn }
// where `used`/`limit` are ELEMENT counts and `resetIn` is seconds until the
// next UTC midnight. The counter is only incremented when ok=true (i.e. the
// request is admitted); once at/over the limit we stop incrementing so `used`
// parks at (or just over) the limit.

// UTC-day bucket: which 86400-second day `nowSec` falls in. Rolls at 00:00 UTC.
export function dayBucket(nowSec: number): number {
  return Math.floor(nowSec / 86400);
}

// Seconds until the next UTC midnight (when the day bucket rolls and the
// counter resets).
export function secondsUntilUtcMidnight(nowSec: number): number {
  return 86400 - (nowSec % 86400);
}

export interface GlobalLimitResult {
  ok: boolean;
  // Elements used / element budget for the current UTC day.
  used: number;
  limit: number;
  // Seconds until the next UTC midnight (when the day bucket rolls).
  resetIn: number;
}

export const DEFAULT_GLOBAL_DAILY_LIMIT = 25_000;

interface GlobalLimiterEnv {
  [k: string]: unknown;
}

// Read the global daily ELEMENT cap from env. Reads GLOBAL_ELEMENTS_PER_DAY,
// falling back to the legacy GLOBAL_DAILY_LIMIT when the element-named key is
// absent (so existing deployments/forks keep working). Default 25,000 elements;
// 0 (or negative) disables the cap entirely.
export function readGlobalLimitFromEnv(env: { [k: string]: unknown }): number {
  const raw = env.GLOBAL_ELEMENTS_PER_DAY ?? env.GLOBAL_DAILY_LIMIT;
  if (raw === undefined || raw === null || raw === "") return DEFAULT_GLOBAL_DAILY_LIMIT;
  const n = Number(raw);
  return Number.isFinite(n) ? n : DEFAULT_GLOBAL_DAILY_LIMIT;
}

export class GlobalLimiter {
  // The day bucket the in-memory count belongs to, and the number of admitted
  // requests counted in it. When the live bucket advances past `bucket`, the
  // count is stale and treated as 0 (the day rolled). Not persisted -- see the
  // file header on fail-open.
  private bucket = -1;
  private count = 0;
  private env: GlobalLimiterEnv;

  constructor(_state: DurableObjectState, env: GlobalLimiterEnv) {
    this.env = env;
  }

  /**
   * Pure-ish core: given the configured element budget, the current instant, and
   * this request's element count, roll the day bucket if needed, decide whether
   * the request is admitted, and (only when admitted) add `elements` to the
   * in-memory counter. Exposed as a method (not just fetch) so the
   * bucket/counter/reset logic is unit-testable without a Request.
   *
   * Admit-then-charge: blocks only when already at/over the budget
   * (count >= limit); an admitted boundary request can overshoot by up to
   * `elements`-1 (< MAX_ELEMENTS), matching the per-IP semantics.
   *
   * limit <= 0 disables the cap: always ok, and we don't bother counting.
   */
  check(limit: number, nowSec: number, elements: number): GlobalLimitResult {
    const resetIn = secondsUntilUtcMidnight(nowSec);

    if (limit <= 0) {
      // Cap disabled. Report the live count for observability but never block.
      return { ok: true, used: this.count, limit, resetIn };
    }

    const bkt = dayBucket(nowSec);
    if (bkt !== this.bucket) {
      // Day rolled (or first call): reset the counter for the new day.
      this.bucket = bkt;
      this.count = 0;
    }

    if (this.count >= limit) {
      // Over the cap: do NOT charge (parks `used` at the limit).
      return { ok: false, used: this.count, limit, resetIn };
    }

    // Admitted: charge this request's elements against the global daily budget.
    this.count += elements;
    return { ok: true, used: this.count, limit, resetIn };
  }

  /**
   * RPC entrypoint. The Worker calls stub.fetch(...) with an optional body:
   *   { now?: number, elements?: number }
   *     now      -- optional epoch seconds; defaults to the DO's clock
   *     elements -- element count to charge; defaults to 1
   * The element budget comes from this DO's own env (GLOBAL_ELEMENTS_PER_DAY,
   * falling back to legacy GLOBAL_DAILY_LIMIT), so the Worker doesn't forward it.
   * Returns the GlobalLimitResult as JSON.
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
      body = {};
    }
    const limit = readGlobalLimitFromEnv(this.env);
    const now = typeof body.now === "number" ? body.now : Math.floor(Date.now() / 1000);
    const elements = typeof body.elements === "number" && body.elements >= 0 ? body.elements : 1;
    const result = this.check(limit, now, elements);
    return Response.json(result);
  }
}
