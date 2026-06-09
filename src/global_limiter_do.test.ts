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

test("readGlobalLimitFromEnv defaults to 25000 elements when unset/empty", () => {
  assert.equal(readGlobalLimitFromEnv({}), DEFAULT_GLOBAL_DAILY_LIMIT);
  assert.equal(readGlobalLimitFromEnv({ GLOBAL_ELEMENTS_PER_DAY: "" }), 25000);
  assert.equal(readGlobalLimitFromEnv({ GLOBAL_ELEMENTS_PER_DAY: undefined }), 25000);
});

test("readGlobalLimitFromEnv reads the element-named key", () => {
  assert.equal(readGlobalLimitFromEnv({ GLOBAL_ELEMENTS_PER_DAY: "100" }), 100);
  assert.equal(readGlobalLimitFromEnv({ GLOBAL_ELEMENTS_PER_DAY: "0" }), 0); // disable
});

test("readGlobalLimitFromEnv falls back to legacy GLOBAL_DAILY_LIMIT", () => {
  // A fork that only set the old key keeps working.
  assert.equal(readGlobalLimitFromEnv({ GLOBAL_DAILY_LIMIT: "5000" }), 5000);
  assert.equal(readGlobalLimitFromEnv({ GLOBAL_DAILY_LIMIT: "0" }), 0);
});

test("readGlobalLimitFromEnv prefers the element-named key over the legacy one", () => {
  assert.equal(
    readGlobalLimitFromEnv({ GLOBAL_ELEMENTS_PER_DAY: "25000", GLOBAL_DAILY_LIMIT: "1000" }),
    25000,
  );
});

test("readGlobalLimitFromEnv falls back on a non-numeric value", () => {
  assert.equal(readGlobalLimitFromEnv({ GLOBAL_ELEMENTS_PER_DAY: "nope" }), DEFAULT_GLOBAL_DAILY_LIMIT);
});

// --- DO in-memory counter behavior -----------------------------------------

function makeGL(env: Record<string, unknown> = {}): GlobalLimiter {
  // The DO only touches `env` (for the limit); state is unused by check().
  return new GlobalLimiter({} as DurableObjectState, env);
}

test("check charges elements and reports used/limit/resetIn", () => {
  const gl = makeGL();
  const now = 86400 * 100 + 1; // 1s past a UTC midnight
  const r1 = gl.check(100, now, 25); // a 5x5 matrix
  assert.equal(r1.ok, true);
  assert.equal(r1.used, 25); // charged elements, not 1
  assert.equal(r1.limit, 100);
  assert.equal(r1.resetIn, 86400 - 1);
  const r2 = gl.check(100, now, 10);
  assert.equal(r2.used, 35); // 25 + 10
});

test("check blocks once at the element budget and does NOT charge further", () => {
  const gl = makeGL();
  const now = 1000;
  assert.equal(gl.check(30, now, 10).ok, true); // used=10
  assert.equal(gl.check(30, now, 10).ok, true); // used=20
  assert.equal(gl.check(30, now, 10).ok, true); // used=30 (hits the limit exactly)
  const blocked1 = gl.check(30, now, 5);
  assert.equal(blocked1.ok, false);
  assert.equal(blocked1.used, 30); // parked at the limit, not charged
  const blocked2 = gl.check(30, now, 5);
  assert.equal(blocked2.ok, false);
  assert.equal(blocked2.used, 30);
});

test("check admit-then-charge allows a boundary request to overshoot", () => {
  const gl = makeGL();
  const now = 1000;
  gl.check(30, now, 20); // used=20 (< 30)
  const over = gl.check(30, now, 25); // admitted (20 < 30), pushes to 45
  assert.equal(over.ok, true);
  assert.equal(over.used, 45);
  assert.equal(gl.check(30, now, 1).ok, false); // now over
});

test("check resets the element counter when the UTC day rolls", () => {
  const gl = makeGL();
  const day0 = 86400 * 10 + 500;
  gl.check(20, day0, 20); // used=20
  assert.equal(gl.check(20, day0, 1).ok, false); // over for day 10
  const day1 = 86400 * 11 + 5;
  const next = gl.check(20, day1, 5);
  assert.equal(next.ok, true);
  assert.equal(next.used, 5);
  assert.equal(next.resetIn, 86400 - 5);
});

test("check with limit<=0 disables the cap (never blocks, does not count)", () => {
  const gl = makeGL();
  const now = 2000;
  for (let i = 0; i < 50; i++) {
    const r = gl.check(0, now, 25);
    assert.equal(r.ok, true);
    assert.equal(r.used, 0); // disabled => no counting
    assert.equal(r.limit, 0);
  }
});

test("fetch RPC returns JSON {ok,used,limit,resetIn} and charges elements", async () => {
  const gl = makeGL({ GLOBAL_ELEMENTS_PER_DAY: "100" });
  const now = 86400 * 7 + 100;
  const resp = await gl.fetch(
    new Request("https://gl/check", {
      method: "POST",
      body: JSON.stringify({ now, elements: 25 }),
    }),
  );
  assert.equal(resp.status, 200);
  const body = (await resp.json()) as { ok: boolean; used: number; limit: number; resetIn: number };
  assert.equal(body.ok, true);
  assert.equal(body.used, 25); // charged the element count
  assert.equal(body.limit, 100);
  assert.equal(body.resetIn, 86400 - 100);
});

test("fetch defaults elements to 1 when omitted", async () => {
  const gl = makeGL({ GLOBAL_ELEMENTS_PER_DAY: "100" });
  const resp = await gl.fetch(
    new Request("https://gl/check", { method: "POST", body: JSON.stringify({ now: 1000 }) }),
  );
  const body = (await resp.json()) as { used: number };
  assert.equal(body.used, 1);
});

test("fetch honors the legacy GLOBAL_DAILY_LIMIT env key", async () => {
  const gl = makeGL({ GLOBAL_DAILY_LIMIT: "50" });
  const resp = await gl.fetch(
    new Request("https://gl/check", { method: "POST", body: JSON.stringify({ now: 1000, elements: 5 }) }),
  );
  const body = (await resp.json()) as { limit: number; used: number };
  assert.equal(body.limit, 50);
  assert.equal(body.used, 5);
});

test("fetch returns 404 for an unknown path", async () => {
  const gl = makeGL();
  const resp = await gl.fetch(new Request("https://gl/nope", { method: "POST" }));
  assert.equal(resp.status, 404);
});
