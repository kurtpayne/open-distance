import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeQuery, hasHouseNumber } from "./normalize.ts";

test("normalizeQuery lowercases + drops punctuation", () => {
  assert.equal(normalizeQuery("1 Market St, SF, CA"), "1 market st sf ca");
});

test("normalizeQuery abbreviates suffixes ('road' -> 'rd')", () => {
  assert.equal(normalizeQuery("700 Bair Island Road"), "700 bair island rd");
  assert.equal(normalizeQuery("1 Hacker Way"), "1 hacker way");
  assert.equal(normalizeQuery("100 Main Street"), "100 main st");
  assert.equal(normalizeQuery("123 South Oak Avenue"), "123 s oak ave");
});

test("normalizeQuery is empty for empty input", () => {
  assert.equal(normalizeQuery(""), "");
  assert.equal(normalizeQuery("  ,,, "), "");
});

test("normalizeQuery collapses whitespace", () => {
  assert.equal(normalizeQuery("  1   market  st  "), "1 market st");
});

test("hasHouseNumber accepts street addresses", () => {
  for (const q of ["1 Market St, San Francisco, CA", "1100 Congress Ave, Austin, TX 78701",
                   "12a main st", "1-15 broadway, new york, ny", "78701 ranch rd, tx"]) {
    assert.equal(hasHouseNumber(normalizeQuery(q)), true, q);
  }
});

test("hasHouseNumber rejects city-, ZIP- and street-only queries", () => {
  for (const q of ["Austin, TX", "Dallas TX", "78701", "78701 tx", "Main St, Austin, TX",
                   "san francisco", "", "tx"]) {
    assert.equal(hasHouseNumber(normalizeQuery(q)), false, q);
  }
});
