import { test } from "node:test";
import assert from "node:assert/strict";
import {
  dayBucket,
  secondsUntilUtcMidnight,
  readGlobalLimitFromEnv,
  DEFAULT_GLOBAL_DAILY_LIMIT,
  GlobalLimiter,
} from "./global_limiter_do.ts";

// --- pure helpers ----------------------------------------------------------

test("dayBucket buckets by UTC day (86400s)", () => {
  assert.equal(dayBucket(0), 0);
  assert.equal(dayBucket(86399), 0);
  assert.equal(dayBucket(86400), 1); // first second of day 1
  assert.equal(dayBucket(86400 * 5 + 10), 5);
});

test("secondsUntilUtcMidnight counts down to the next day roll", () => {
  assert.equal(secondsUntilUtcMidnight(0), 86400); // start of a day
  assert.equal(secondsUntilUtcMidnight(1), 86399);
  assert.equal(secondsUntilUtcMidnight(86400 - 1), 1); // one sec before midnight
  assert.equal(secondsUntilUtcMidnight(86400), 86400); // start of next day
});

test("readGlobalLimitFromEnv defaults to 25000 when unset/empty", () => {
  assert.equal(readGlobalLimitFromEnv({}), DEFAULT_GLOBAL_DAILY_LIMIT);
  assert.equal(readGlobalLimitFromEnv({ GLOBAL_DAILY_LIMIT: "" }), 25000);
  assert.equal(readGlobalLimitFromEnv({ GLOBAL_DAILY_LIMIT: undefined }), 25000);
});

test("readGlobalLimitFromEnv honors an override and 0 (disable)", () => {
  assert.equal(readGlobalLimitFromEnv({ GLOBAL_DAILY_LIMIT: "100" }), 100);
  assert.equal(readGlobalLimitFromEnv({ GLOBAL_DAILY_LIMIT: 0 }), 0);
  assert.equal(readGlobalLimitFromEnv({ GLOBAL_DAILY_LIMIT: "0" }), 0);
});

test("readGlobalLimitFromEnv falls back on a non-numeric value", () => {
  assert.equal(readGlobalLimitFromEnv({ GLOBAL_DAILY_LIMIT: "nope" }), DEFAULT_GLOBAL_DAILY_LIMIT);
});

// --- DO in-memory counter behavior -----------------------------------------

function makeGL(env: Record<string, unknown> = {}): GlobalLimiter {
  // The DO only touches `env` (for the limit); state is unused by check().
  return new GlobalLimiter({} as DurableObjectState, env);
}

test("check counts admitted requests and reports used/limit/resetIn", () => {
  const gl = makeGL();
  const now = 86400 * 100 + 1; // 1s past a UTC midnight
  const r1 = gl.check(3, now);
  assert.equal(r1.ok, true);
  assert.equal(r1.used, 1);
  assert.equal(r1.limit, 3);
  assert.equal(r1.resetIn, 86400 - 1);
  const r2 = gl.check(3, now);
  assert.equal(r2.used, 2);
});

test("check blocks once at the limit and does NOT increment further", () => {
  const gl = makeGL();
  const now = 1000;
  assert.equal(gl.check(2, now).ok, true); // used=1
  assert.equal(gl.check(2, now).ok, true); // used=2
  const blocked1 = gl.check(2, now);
  assert.equal(blocked1.ok, false);
  assert.equal(blocked1.used, 2); // parked at the limit, not incremented
  const blocked2 = gl.check(2, now);
  assert.equal(blocked2.ok, false);
  assert.equal(blocked2.used, 2); // still 2 -- blocked requests never count
});

test("check resets the counter when the UTC day rolls", () => {
  const gl = makeGL();
  const day0 = 86400 * 10 + 500;
  gl.check(2, day0); // used=1
  gl.check(2, day0); // used=2
  assert.equal(gl.check(2, day0).ok, false); // over for day 10
  // Next UTC day: counter resets.
  const day1 = 86400 * 11 + 5;
  const next = gl.check(2, day1);
  assert.equal(next.ok, true);
  assert.equal(next.used, 1);
  assert.equal(next.resetIn, 86400 - 5);
});

test("check with limit<=0 disables the cap (never blocks, does not count)", () => {
  const gl = makeGL();
  const now = 2000;
  for (let i = 0; i < 50; i++) {
    const r = gl.check(0, now);
    assert.equal(r.ok, true);
    assert.equal(r.used, 0); // disabled => no counting
    assert.equal(r.limit, 0);
  }
});

test("fetch RPC returns JSON {ok,used,limit,resetIn} and increments", async () => {
  const gl = makeGL({ GLOBAL_DAILY_LIMIT: "5" });
  const now = 86400 * 7 + 100;
  const resp = await gl.fetch(
    new Request("https://gl/check", { method: "POST", body: JSON.stringify({ now }) }),
  );
  assert.equal(resp.status, 200);
  const body = (await resp.json()) as { ok: boolean; used: number; limit: number; resetIn: number };
  assert.equal(body.ok, true);
  assert.equal(body.used, 1);
  assert.equal(body.limit, 5);
  assert.equal(body.resetIn, 86400 - 100);
});

test("fetch returns 404 for an unknown path", async () => {
  const gl = makeGL();
  const resp = await gl.fetch(new Request("https://gl/nope", { method: "POST" }));
  assert.equal(resp.status, 404);
});
