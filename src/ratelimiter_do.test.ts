import { test } from "node:test";
import assert from "node:assert/strict";
import { computeTiers, evaluateTiers, tierResetIn, rateLimitResponse } from "./ratelimit.ts";
import type { RateLimitResult } from "./ratelimit.ts";
import { RateLimiter } from "./ratelimiter_do.ts";
import { contactCta } from "./config.ts";

const CFG = { perSec: 5, perHour: 100, perDay: 1000 };

// --- pure windowing/decision logic (shared by KV-era + DO) -----------------

test("computeTiers buckets sec/hour/day from the same instant", () => {
  const now = 3_600_123; // arbitrary epoch seconds
  const tiers = computeTiers(CFG, now);
  assert.deepEqual(tiers.map(t => t.name), ["sec", "hour", "day"]);
  assert.equal(tiers[0].bucket, now);
  assert.equal(tiers[1].bucket, Math.floor(now / 3600));
  assert.equal(tiers[2].bucket, Math.floor(now / 86400));
});

test("computeTiers drops a tier whose limit is 0 (disabled)", () => {
  const tiers = computeTiers({ perSec: 0, perHour: 100, perDay: 0 }, 1000);
  assert.deepEqual(tiers.map(t => t.name), ["hour"]);
});

test("evaluateTiers allows and returns incremented counts", () => {
  const now = 1000;
  const tiers = computeTiers(CFG, now);
  const { result, newCounts } = evaluateTiers(tiers, [0, 0, 0], now);
  assert.equal(result.ok, true);
  assert.deepEqual(newCounts, [1, 1, 1]);
  const sec = result.tiers.find(t => t.name === "sec")!;
  assert.equal(sec.used, 1);
  assert.equal(sec.remaining, 4); // 5 - 1
});

test("evaluateTiers blocks when a tier is at its limit and does not increment", () => {
  const now = 1000;
  const tiers = computeTiers(CFG, now);
  // sec tier already used all 5.
  const { result, newCounts } = evaluateTiers(tiers, [5, 10, 10], now);
  assert.equal(result.ok, false);
  assert.equal(result.limitName, "sec");
  assert.equal(result.currentCount, 5);
  assert.equal(result.retryAfter, 1); // sec window rolls in 1s
  assert.deepEqual(newCounts, [5, 10, 10]); // unchanged on block
});

test("evaluateTiers with no active tiers is unlimited", () => {
  const { result } = evaluateTiers([], [], 1000);
  assert.equal(result.ok, true);
  assert.deepEqual(result.tiers, []);
});

test("tierResetIn reflects time-to-window-roll", () => {
  assert.equal(tierResetIn("sec", 12345), 1);
  assert.equal(tierResetIn("hour", 3600), 3600);     // start of an hour
  assert.equal(tierResetIn("hour", 3601), 3599);
  assert.equal(tierResetIn("day", 86400), 86400);    // start of a day
});

// --- DO in-memory counter behavior -----------------------------------------

function makeRL(env: Record<string, unknown> = {}): RateLimiter {
  // The DO only touches `env` (for limits); state is unused by check().
  return new RateLimiter({} as DurableObjectState, env);
}

test("RateLimiter.check counts up within the same second then blocks", () => {
  const rl = makeRL();
  const now = 1000;
  // 5 allowed (perSec = 5), 6th blocked.
  for (let i = 1; i <= 5; i++) {
    const r = rl.check(CFG, now);
    assert.equal(r.ok, true, `request ${i} should be allowed`);
    assert.equal(r.tiers.find(t => t.name === "sec")!.used, i);
  }
  const blocked = rl.check(CFG, now);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.limitName, "sec");
});

test("RateLimiter.check resets the per-second counter when the window rolls", () => {
  const rl = makeRL();
  // Exhaust the second at t=1000.
  for (let i = 0; i < 5; i++) rl.check(CFG, 1000);
  assert.equal(rl.check(CFG, 1000).ok, false);
  // Next second: sec counter resets, but the hour counter keeps accumulating.
  const next = rl.check(CFG, 1001);
  assert.equal(next.ok, true);
  assert.equal(next.tiers.find(t => t.name === "sec")!.used, 1);
  // 5 from the first second + 1 now = 6 in the hour window.
  assert.equal(next.tiers.find(t => t.name === "hour")!.used, 6);
});

test("RateLimiter.check enforces the hour tier across many seconds", () => {
  const rl = makeRL({ RL_PER_SEC: "0", RL_PER_HOUR: "3", RL_PER_DAY: "0" });
  const cfg = { perSec: 0, perHour: 3, perDay: 0 };
  let now = 5000;
  for (let i = 1; i <= 3; i++) {
    assert.equal(rl.check(cfg, now).ok, true, `hour req ${i}`);
    now += 1; // advance a second each time; same hour bucket
  }
  assert.equal(rl.check(cfg, now).ok, false); // 4th in the hour blocked
});

test("RateLimiter.check does not increment counters on a blocked request", () => {
  const rl = makeRL();
  for (let i = 0; i < 5; i++) rl.check(CFG, 2000);
  const a = rl.check(CFG, 2000); // blocked
  const b = rl.check(CFG, 2000); // still blocked, count must not have grown
  assert.equal(a.ok, false);
  assert.equal(b.ok, false);
  assert.equal(a.currentCount, 5);
  assert.equal(b.currentCount, 5);
});

// --- rateLimitResponse contact CTA -----------------------------------------

const BLOCKED: RateLimitResult = {
  ok: false,
  tiers: [{ name: "sec", limit: 5, used: 5, remaining: 0, resetIn: 1 }],
  retryAfter: 1,
  limitName: "sec",
  currentCount: 5,
};

test("rateLimitResponse appends the contact CTA when one is provided", async () => {
  const cta = contactCta("hello@open-distance.com");
  const resp = rateLimitResponse(BLOCKED, CFG, cta);
  assert.equal(resp.status, 429);
  const body = (await resp.json()) as { error_message: string };
  assert.match(body.error_message, /Contact hello@open-distance\.com for custom solutions\./);
});

test("rateLimitResponse omits the CTA (and any email) when cta is empty", async () => {
  const resp = rateLimitResponse(BLOCKED, CFG, "");
  const body = (await resp.json()) as { error_message: string };
  assert.doesNotMatch(body.error_message, /Contact/);
  assert.doesNotMatch(body.error_message, /@/);
});

test("rateLimitResponse cta defaults to empty (no email) when the arg is omitted", async () => {
  const resp = rateLimitResponse(BLOCKED, CFG);
  const body = (await resp.json()) as { error_message: string };
  assert.doesNotMatch(body.error_message, /@/);
});
