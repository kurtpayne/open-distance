import { test } from "node:test";
import assert from "node:assert/strict";
import { parseState } from "./state_parser.ts";

test("parseState picks the trailing USPS code", () => {
  assert.equal(parseState("1 Market St, San Francisco, CA"), "CA");
  assert.equal(parseState("753 S 49th St, Richmond, CA 94804"), "CA");
  assert.equal(parseState("1466 Broadway, New York, NY 10036"), "NY");
});

test("parseState ignores 2-char tokens that aren't state codes", () => {
  // "ST" is a 2-char token but not a state code; should not be picked.
  // The trailing "CA" wins.
  assert.equal(parseState("1 Main St Apt B, Anytown, CA"), "CA");
});

test("parseState falls back to full state name", () => {
  assert.equal(parseState("123 Main St, Boston, Massachusetts"), "MA");
  assert.equal(parseState("100 Oak Ave, Dallas, Texas 75201"), "TX");
});

test("parseState uses ZIP-3 lookup when no code/name", () => {
  // 100xx -> NY  (Manhattan ZIPs)
  assert.equal(parseState("1 Main St 10001"), "NY");
  // 900xx -> CA (LA basin)
  assert.equal(parseState("100 Oak 90210"), "CA");
  // 200xx -> DC (avoid 'Pennsylvania' in the string since that name itself
  // resolves to PA before the ZIP fallback runs).
  assert.equal(parseState("100 Main 20500"), "DC");
});

test("parseState returns null for unidentifiable input", () => {
  assert.equal(parseState("no state info here"), null);
  assert.equal(parseState("123 Main St"), null);
});
