# Security policy

## Reporting a vulnerability

If you find a security issue in `open-distance` — the code, a data-handling
flaw, or the hosted deployment at https://open-distance.com — please **do
not** open a public GitHub issue.

Instead, report privately via GitHub's security advisory flow:

**https://github.com/kurtpayne/open-distance/security/advisories/new**

We aim to acknowledge new reports within 72 hours.

## What we ask you to include

- A description of the issue and the impact you believe it has.
- Steps to reproduce (a curl invocation, a code snippet, a request/response
  pair). The smaller the repro, the faster we can confirm.
- Whether you've shared this with anyone else.

## What we'll do

- Confirm receipt within 72 hours.
- Triage and respond with a likely resolution timeline.
- Credit you in the advisory if you'd like (or keep your report anonymous).

## Scope

In scope:

- The Worker code in this repository.
- The hosted deployment at https://open-distance.com.
- The data pipeline (`refresh.sh`, `etl/`) where a bug could lead to data
  injection, exposure, or denial of service.

Out of scope:

- Cloudflare platform vulnerabilities (report to Cloudflare directly).
- Issues only affecting forks with custom modifications.
- Rate-limit avoidance research (the rate limit is best-effort, not a
  security boundary).

## Disclosure

We follow coordinated disclosure: we'll work with you on a fix before any
public discussion, and we'll publish an advisory when a fix is available.
