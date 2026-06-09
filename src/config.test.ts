import { test } from "node:test";
import assert from "node:assert/strict";
import {
  readContactEmail,
  contactCta,
  readMaxElements,
  resolveSiteConfig,
  DEFAULT_CONTACT_EMAIL,
  DEFAULT_MAX_ELEMENTS,
} from "./config.ts";

// --- CONTACT_EMAIL ----------------------------------------------------------

test("readContactEmail defaults to hello@open-distance.com when unset", () => {
  assert.equal(readContactEmail({}), DEFAULT_CONTACT_EMAIL);
  assert.equal(readContactEmail({ CONTACT_EMAIL: undefined }), DEFAULT_CONTACT_EMAIL);
  assert.equal(readContactEmail({ CONTACT_EMAIL: null }), DEFAULT_CONTACT_EMAIL);
});

test("readContactEmail honours an override", () => {
  assert.equal(readContactEmail({ CONTACT_EMAIL: "ops@example.com" }), "ops@example.com");
});

test("readContactEmail preserves an explicit empty string (does NOT fall back)", () => {
  // An explicit "" is meaningful: it suppresses the CTA. It must not become the default.
  assert.equal(readContactEmail({ CONTACT_EMAIL: "" }), "");
});

test("contactCta builds a leading-space sentence when an email is set", () => {
  assert.equal(contactCta("hello@open-distance.com"), " Contact hello@open-distance.com for custom solutions.");
  assert.equal(contactCta("ops@example.com"), " Contact ops@example.com for custom solutions.");
});

test("contactCta returns an empty string when the email is blank (CTA suppressed)", () => {
  assert.equal(contactCta(""), "");
});

test("CONTACT_EMAIL='' end-to-end suppresses the CTA", () => {
  // The forker-suppression path: env -> readContactEmail -> contactCta -> "".
  assert.equal(contactCta(readContactEmail({ CONTACT_EMAIL: "" })), "");
});

// --- MAX_ELEMENTS -----------------------------------------------------------

test("readMaxElements defaults to 25 when unset/empty", () => {
  assert.equal(readMaxElements({}), DEFAULT_MAX_ELEMENTS);
  assert.equal(readMaxElements({ MAX_ELEMENTS: "" }), 25);
  assert.equal(readMaxElements({ MAX_ELEMENTS: undefined }), 25);
});

test("readMaxElements honours a string override (env vars arrive as strings)", () => {
  assert.equal(readMaxElements({ MAX_ELEMENTS: "100" }), 100);
  assert.equal(readMaxElements({ MAX_ELEMENTS: "1" }), 1);
});

test("readMaxElements floors at 1 and truncates fractions", () => {
  assert.equal(readMaxElements({ MAX_ELEMENTS: "0" }), 1);
  assert.equal(readMaxElements({ MAX_ELEMENTS: "-5" }), 1);
  assert.equal(readMaxElements({ MAX_ELEMENTS: "7.9" }), 7);
});

test("readMaxElements falls back to the default on a non-numeric value", () => {
  assert.equal(readMaxElements({ MAX_ELEMENTS: "abc" }), DEFAULT_MAX_ELEMENTS);
});

// --- resolveSiteConfig ------------------------------------------------------

test("resolveSiteConfig assembles every knob from env + provided limits", () => {
  const cfg = resolveSiteConfig(
    { MAX_ELEMENTS: "50", CONTACT_EMAIL: "ops@example.com" },
    { perSec: 5, perHour: 100, perDay: 1000 },
    25000,
  );
  assert.deepEqual(cfg, {
    perSec: 5,
    perHour: 100,
    perDay: 1000,
    globalDaily: 25000,
    maxElements: 50,
    contactEmail: "ops@example.com",
  });
});

test("resolveSiteConfig carries a blank contact email through (CTA-suppressing fork)", () => {
  const cfg = resolveSiteConfig(
    { CONTACT_EMAIL: "" },
    { perSec: 5, perHour: 100, perDay: 1000 },
    0,
  );
  assert.equal(cfg.contactEmail, "");
  assert.equal(cfg.maxElements, DEFAULT_MAX_ELEMENTS);
  assert.equal(cfg.globalDaily, 0);
});
