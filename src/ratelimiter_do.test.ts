import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeTiers,
  evaluateTiers,
  tierResetIn,
  rateLimitResponse,
  readLimitsFromEnv,
  DEFAULT_LIMITS,
} from "./ratelimit.ts";
import type { RateLimitResult } from "./ratelimit.ts";
import { RateLimiter } from "./ratelimiter_do.ts";
import { contactCta } from "./config.ts";

// Hybrid defaults: 5 requests/sec (burst), 2500 elements/day (cost budget).
const CFG = { perSec: 5, perDay: 2500 };

// --- env reading (element-named keys + legacy fallback) ---------------------

test("readLimitsFromEnv defaults to 5/sec and 2500 elements/day", () => {
  assert.deepEqual(readLimitsFromEnv({}), DEFAULT_LIMITS);
  assert.deepEqual(readLimitsFromEnv({}), { perSec: 5, perDay: 2500 });
});

test("readLimitsFromEnv reads the element-named per-day key", () => {
  assert.deepEqual(readLimitsFromEnv({ RL_PER_SEC: "10", RL_ELEMENTS_PER_DAY: "5000" }), {
    perSec: 10,
    perDay: 5000,
  });
});

test("readLimitsFromEnv falls back to legacy RL_PER_DAY for the per-day budget", () => {
  // A fork that only set the old key keeps working: RL_PER_DAY -> perDay.
  assert.deepEqual(readLimitsFromEnv({ RL_PER_DAY: "1000" }), { perSec: 5, perDay: 1000 });
});

test("readLimitsFromEnv prefers the element-named key over the legacy one", () => {
  const cfg = readLimitsFromEnv({ RL_ELEMENTS_PER_DAY: "2500", RL_PER_DAY: "1000" });
  assert.equal(cfg.perDay, 2500);
});

// --- pure windowing/decision logic -----------------------------------------

test("computeTiers buckets sec/day from the same instant (no hour tier)", () => {
  const now = 3_600_123; // arbitrary epoch seconds
  const tiers = computeTiers(CFG, now);
  assert.deepEqual(tiers.map(t => t.name), ["sec", "day"]);
  assert.equal(tiers[0].bucket, now);
  assert.equal(tiers[1].bucket, Math.floor(now / 86400));
});

test("computeTiers drops a tier whose limit is 0 (disabled)", () => {
  assert.deepEqual(computeTiers({ perSec: 0, perDay: 2500 }, 1000).map(t => t.name), ["day"]);
  assert.deepEqual(computeTiers({ perSec: 5, perDay: 0 }, 1000).map(t => t.name), ["sec"]);
});

test("evaluateTiers charges 1 to sec and `elements` to day (5x5 -> 25)", () => {
  const now = 1000;
  const tiers = computeTiers(CFG, now);
  const { result, newCounts } = evaluateTiers(tiers, [0, 0], now, 25);
  assert.equal(result.ok, true);
  // sec += 1, day += 25
  assert.deepEqual(newCounts, [1, 25]);
  const sec = result.tiers.find(t => t.name === "sec")!;
  const day = result.tiers.find(t => t.name === "day")!;
  assert.equal(sec.used, 1);
  assert.equal(sec.remaining, 4); // 5 - 1
  assert.equal(day.used, 25);
  assert.equal(day.remaining, 2475); // 2500 - 25
});

test("evaluateTiers single-element request charges 1 to both tiers", () => {
  const { result, newCounts } = evaluateTiers(computeTiers(CFG, 1000), [0, 0], 1000, 1);
  assert.equal(result.ok, true);
  assert.deepEqual(newCounts, [1, 1]);
});

test("evaluateTiers with elements=0 charges only the per-second burst", () => {
  // Malformed/missing params -> elements 0: per-second still consumes a slot,
  // the daily element budget is untouched.
  const { result, newCounts } = evaluateTiers(computeTiers(CFG, 1000), [0, 0], 1000, 0);
  assert.equal(result.ok, true);
  assert.deepEqual(newCounts, [1, 0]);
});

test("evaluateTiers blocks on the per-second burst and does not charge", () => {
  const now = 1000;
  const tiers = computeTiers(CFG, now);
  // sec tier already used all 5.
  const { result, newCounts } = evaluateTiers(tiers, [5, 100], now, 25);
  assert.equal(result.ok, false);
  assert.equal(result.limitName, "sec");
  assert.equal(result.currentCount, 5);
  assert.equal(result.retryAfter, 1); // sec window rolls in 1s
  assert.deepEqual(newCounts, [5, 100]); // unchanged on block
});

test("evaluateTiers blocks on the per-day element budget", () => {
  const now = 1000;
  const tiers = computeTiers(CFG, now);
  // day budget already at the 2500-element limit.
  const { result, newCounts } = evaluateTiers(tiers, [1, 2500], now, 5);
  assert.equal(result.ok, false);
  assert.equal(result.limitName, "day");
  assert.equal(result.currentCount, 2500);
  assert.equal(result.retryAfter, tierResetIn("day", now));
  assert.deepEqual(newCounts, [1, 2500]);
});

test("evaluateTiers admit-then-charge allows a boundary request to overshoot", () => {
  const now = 1000;
  const tiers = computeTiers(CFG, now);
  // day used 2490 (< 2500), a 25-element request is admitted and pushes to 2515.
  const { result, newCounts } = evaluateTiers(tiers, [0, 2490], now, 25);
  assert.equal(result.ok, true);
  assert.equal(newCounts[1], 2515); // overshoot < MAX_ELEMENTS by design
  const day = result.tiers.find(t => t.name === "day")!;
  assert.equal(day.remaining, 0); // floored at 0
});

test("evaluateTiers with no active tiers is unlimited", () => {
  const { result } = evaluateTiers([], [], 1000, 25);
  assert.equal(result.ok, true);
  assert.deepEqual(result.tiers, []);
});

test("tierResetIn reflects time-to-window-roll", () => {
  assert.equal(tierResetIn("sec", 12345), 1);
  assert.equal(tierResetIn("day", 86400), 86400);    // start of a day
  assert.equal(tierResetIn("day", 86401), 86399);
});

// --- DO in-memory counter behavior -----------------------------------------

function makeRL(env: Record<string, unknown> = {}): RateLimiter {
  // The DO only touches `env` (for limits); state is unused by check().
  return new RateLimiter({} as DurableObjectState, env);
}

test("RateLimiter.check counts requests within the same second then blocks (burst)", () => {
  const rl = makeRL();
  const now = 1000;
  // 5 allowed (perSec = 5), 6th blocked. Each charges 1 element to the day tier.
  for (let i = 1; i <= 5; i++) {
    const r = rl.check(CFG, now, 1);
    assert.equal(r.ok, true, `request ${i} should be allowed`);
    assert.equal(r.tiers.find(t => t.name === "sec")!.used, i);
  }
  const blocked = rl.check(CFG, now, 1);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.limitName, "sec");
});

test("RateLimiter.check charges elements to the day tier across seconds", () => {
  const rl = makeRL();
  // A 5x5 (25-element) request at t=1000.
  const a = rl.check(CFG, 1000, 25);
  assert.equal(a.ok, true);
  assert.equal(a.tiers.find(t => t.name === "sec")!.used, 1); // sec charged 1
  assert.equal(a.tiers.find(t => t.name === "day")!.used, 25); // day charged 25
  // Next second: sec counter resets, day keeps accumulating.
  const b = rl.check(CFG, 1001, 10);
  assert.equal(b.ok, true);
  assert.equal(b.tiers.find(t => t.name === "sec")!.used, 1);
  assert.equal(b.tiers.find(t => t.name === "day")!.used, 35); // 25 + 10
});

test("RateLimiter.check enforces the per-day element budget across seconds", () => {
  const rl = makeRL({ RL_PER_SEC: "0", RL_ELEMENTS_PER_DAY: "30" });
  const cfg = { perSec: 0, perDay: 30 };
  let now = 5000;
  // Two 10-element requests (20 used), a third (10) hits exactly 30, a fourth blocks.
  for (let i = 1; i <= 3; i++) {
    assert.equal(rl.check(cfg, now, 10).ok, true, `day req ${i}`);
    now += 1; // advance a second; same day bucket
  }
  assert.equal(rl.check(cfg, now, 10).ok, false); // budget exhausted (30/30)
});

test("RateLimiter.check resets the per-day element budget when the UTC day rolls", () => {
  const rl = makeRL({ RL_PER_SEC: "0", RL_ELEMENTS_PER_DAY: "20" });
  const cfg = { perSec: 0, perDay: 20 };
  const day0 = 86400 * 3 + 100;
  rl.check(cfg, day0, 20); // day budget full
  assert.equal(rl.check(cfg, day0, 1).ok, false);
  const day1 = 86400 * 4 + 5;
  const next = rl.check(cfg, day1, 5);
  assert.equal(next.ok, true);
  assert.equal(next.tiers.find(t => t.name === "day")!.used, 5);
});

test("RateLimiter.check does not charge on a blocked request", () => {
  const rl = makeRL();
  for (let i = 0; i < 5; i++) rl.check(CFG, 2000, 1);
  const a = rl.check(CFG, 2000, 1); // blocked
  const b = rl.check(CFG, 2000, 1); // still blocked, count must not have grown
  assert.equal(a.ok, false);
  assert.equal(b.ok, false);
  assert.equal(a.currentCount, 5);
  assert.equal(b.currentCount, 5);
});

test("RateLimiter.fetch reads the elements field from the body and charges it", async () => {
  const rl = makeRL();
  const resp = await rl.fetch(
    new Request("https://rl/check", {
      method: "POST",
      body: JSON.stringify({ now: 1000, elements: 9 }),
    }),
  );
  assert.equal(resp.status, 200);
  const body = (await resp.json()) as RateLimitResult;
  assert.equal(body.ok, true);
  assert.equal(body.tiers.find(t => t.name === "sec")!.used, 1);
  assert.equal(body.tiers.find(t => t.name === "day")!.used, 9);
});

test("RateLimiter.fetch defaults elements to 1 when omitted", async () => {
  const rl = makeRL();
  const resp = await rl.fetch(
    new Request("https://rl/check", { method: "POST", body: JSON.stringify({ now: 1000 }) }),
  );
  const body = (await resp.json()) as RateLimitResult;
  assert.equal(body.tiers.find(t => t.name === "day")!.used, 1);
});

// --- rateLimitResponse contact CTA + units ---------------------------------

const BLOCKED_SEC: RateLimitResult = {
  ok: false,
  tiers: [{ name: "sec", limit: 5, used: 5, remaining: 0, resetIn: 1 }],
  retryAfter: 1,
  limitName: "sec",
  currentCount: 5,
};

const BLOCKED_DAY: RateLimitResult = {
  ok: false,
  tiers: [{ name: "day", limit: 2500, used: 2500, remaining: 0, resetIn: 3600 }],
  retryAfter: 3600,
  limitName: "day",
  currentCount: 2500,
};

test("rateLimitResponse reports requests/second for the burst tier", async () => {
  const resp = rateLimitResponse(BLOCKED_SEC, CFG);
  assert.equal(resp.status, 429);
  const body = (await resp.json()) as { error_message: string };
  assert.match(body.error_message, /5 requests per second/);
  assert.doesNotMatch(body.error_message, /element/);
});

test("rateLimitResponse reports elements/day for the daily tier", async () => {
  const resp = rateLimitResponse(BLOCKED_DAY, CFG);
  const body = (await resp.json()) as { error_message: string };
  assert.match(body.error_message, /2500 elements per day/);
  assert.match(body.error_message, /origins × destinations/);
});

test("rateLimitResponse appends the contact CTA when one is provided", async () => {
  const cta = contactCta("hello@open-distance.com");
  const resp = rateLimitResponse(BLOCKED_SEC, CFG, cta);
  const body = (await resp.json()) as { error_message: string };
  assert.match(body.error_message, /Contact hello@open-distance\.com for custom solutions\./);
});

test("rateLimitResponse omits the CTA (and any email) when cta is empty", async () => {
  const resp = rateLimitResponse(BLOCKED_SEC, CFG, "");
  const body = (await resp.json()) as { error_message: string };
  assert.doesNotMatch(body.error_message, /Contact/);
  assert.doesNotMatch(body.error_message, /@/);
});

test("rateLimitResponse cta defaults to empty (no email) when the arg is omitted", async () => {
  const resp = rateLimitResponse(BLOCKED_SEC, CFG);
  const body = (await resp.json()) as { error_message: string };
  assert.doesNotMatch(body.error_message, /@/);
});

// --- header units -----------------------------------------------------------

test("rateLimitHeaders surfaces the day tier as an element budget (no hour header)", () => {
  // Build via rateLimitResponse to exercise the header path end to end.
  const result: RateLimitResult = {
    ok: true,
    tiers: [
      { name: "sec", limit: 5, used: 1, remaining: 4, resetIn: 1 },
      { name: "day", limit: 2500, used: 25, remaining: 2475, resetIn: 3600 },
    ],
  };
  const resp = rateLimitResponse({ ...result, ok: false, limitName: "day", retryAfter: 3600 }, CFG);
  assert.equal(resp.headers.get("x-ratelimit-limit-day"), "2500");
  assert.equal(resp.headers.get("x-ratelimit-remaining-day"), "2475");
  assert.equal(resp.headers.get("x-ratelimit-limit-hour"), null); // hour tier gone
});
