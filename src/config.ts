// Operator-tunable knobs read from the Worker env (wrangler.toml [vars] / Worker
// secrets). Self-hosters change behaviour here via config, never by editing code.
//
// Env vars always arrive as strings, so every reader coerces + falls back to the
// production default. The rate-limit tiers live in ratelimit.ts
// (readLimitsFromEnv) and the global cap in global_limiter_do.ts
// (readGlobalLimitFromEnv); this file holds the rest.

// Contact email surfaced in rejection messages + the site copy. Default is the
// hosted deployment's address. A forker can set CONTACT_EMAIL="" to suppress the
// CTA entirely (see contactCta).
export const DEFAULT_CONTACT_EMAIL = "hello@open-distance.com";

// Max origins × destinations elements per request. Default 25; floored at 1.
export const DEFAULT_MAX_ELEMENTS = 25;

// Read the contact email from env. Returns the default when unset; returns the
// caller-supplied value otherwise -- including an explicit "" (which callers use
// to suppress the CTA). The empty string is meaningful, so we only fall back to
// the default when the var is genuinely absent (undefined/null).
export function readContactEmail(env: { [k: string]: unknown }): string {
  const raw = env.CONTACT_EMAIL;
  if (raw === undefined || raw === null) return DEFAULT_CONTACT_EMAIL;
  return String(raw);
}

// Build the contact call-to-action sentence appended to rejection messages.
// Returns " Contact <email> for custom solutions." (leading space so it
// concatenates cleanly after another sentence) when an email is set, or the
// empty string when the email is blank -- letting a forker omit the CTA.
export function contactCta(email: string): string {
  if (!email) return "";
  return ` Contact ${email} for custom solutions.`;
}

// Read the max-elements cap from env. Default 25; coerced from string and
// floored at 1 (a cap of 0 or below would reject every request).
export function readMaxElements(env: { [k: string]: unknown }): number {
  const raw = env.MAX_ELEMENTS;
  if (raw === undefined || raw === null || raw === "") return DEFAULT_MAX_ELEMENTS;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_MAX_ELEMENTS;
  return Math.max(1, Math.floor(n));
}

// Resolved, display-ready view of every operator-tunable knob. Built from env
// once and threaded into the site renderers so a forker's pages show their own
// numbers + contact address (or none) instead of the maintainer's.
export interface SiteConfig {
  perSec: number;
  perHour: number;
  perDay: number;
  globalDaily: number; // account-wide/day; 0 = disabled
  maxElements: number;
  // Contact email, or "" when CONTACT_EMAIL is explicitly blank (CTA suppressed).
  contactEmail: string;
}

// Build the SiteConfig from env. Pulls the per-IP tiers (readLimitsFromEnv) and
// global cap (readGlobalLimitFromEnv) from their owning modules so there's one
// source of truth per knob.
export function resolveSiteConfig(
  env: { [k: string]: unknown },
  limits: { perSec: number; perHour: number; perDay: number },
  globalDaily: number,
): SiteConfig {
  return {
    perSec: limits.perSec,
    perHour: limits.perHour,
    perDay: limits.perDay,
    globalDaily,
    maxElements: readMaxElements(env),
    contactEmail: readContactEmail(env),
  };
}
