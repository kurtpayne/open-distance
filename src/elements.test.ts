import { test } from "node:test";
import assert from "node:assert/strict";
import { countElements } from "./elements.ts";

// countElements is the rate limiter's up-front element counter. It must use the
// SAME pipe-split semantics handleDistanceMatrix applies (trim + drop empties)
// so the budget charged matches what gets served.

function u(qs: string): URL {
  return new URL(`https://open-distance.com/maps/api/distancematrix/json?${qs}`);
}

test("countElements multiplies origins x destinations", () => {
  assert.equal(countElements(u("origins=A&destinations=B")), 1); // 1x1
  assert.equal(countElements(u("origins=A|B|C&destinations=D|E")), 6); // 3x2
  assert.equal(countElements(u("origins=A|B|C|D|E&destinations=F|G|H|I|J")), 25); // 5x5
});

test("countElements returns 0 when either side is missing", () => {
  assert.equal(countElements(u("origins=A")), 0); // no destinations
  assert.equal(countElements(u("destinations=B")), 0); // no origins
  assert.equal(countElements(u("")), 0); // neither
});

test("countElements ignores empty/whitespace pipe segments (matches splitMulti)", () => {
  // Trailing/leading pipes and blank segments are dropped, like the handler does.
  assert.equal(countElements(u("origins=A||B&destinations=C|")), 2); // 2x1
  assert.equal(countElements(u("origins=%20%20&destinations=C")), 0); // all-blank origin -> 0
});
