import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHouseAndStreet } from "./interpolate.ts";

test("parseHouseAndStreet extracts house number, street (normalized), zip", () => {
  const p = parseHouseAndStreet("700 Bair Island Road, Redwood City, CA 94063");
  assert.ok(p);
  assert.equal(p!.number, 700);
  assert.equal(p!.street, "bair island rd");
  assert.equal(p!.zip, "94063");
});

test("parseHouseAndStreet handles addresses without a zip", () => {
  const p = parseHouseAndStreet("1 Hacker Way, Menlo Park, CA");
  assert.ok(p);
  assert.equal(p!.number, 1);
  assert.equal(p!.street, "hacker way");
  assert.equal(p!.zip, null);
});

test("parseHouseAndStreet returns null on inputs without a house number", () => {
  assert.equal(parseHouseAndStreet("Hacker Way, Menlo Park"), null);
  assert.equal(parseHouseAndStreet("just text"), null);
});

test("parseHouseAndStreet picks the LAST zip on multi-zip inputs", () => {
  // ZIP_RE finds the last 5-digit ZIP-shape token, which is the canonical
  // one for the address tail.
  const p = parseHouseAndStreet("12345 Oak Ave, Hometown, CA 90210");
  assert.ok(p);
  assert.equal(p!.zip, "90210");
});
