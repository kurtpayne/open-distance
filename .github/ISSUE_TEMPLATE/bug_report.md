---
name: Bug report
about: Something doesn't work the way it should
title: ''
labels: bug
assignees: ''
---

## What you did

A short description, ideally a curl invocation we can paste verbatim:

```
curl "https://open-distance.com/maps/api/distancematrix/json?origins=...&destinations=..."
```

## What you expected to see

## What you saw instead

Paste the full JSON response if it's not too long, otherwise paste the
relevant fields (`status`, `origin_matches`, `destination_matches`, the
element's `status`).

## Environment

- Region/country (helps us pin down edge-routing oddities)
- If self-hosted: Cloudflare account region, `DATA_VERSION` from `/healthz`
- If hitting the hosted deployment: just say "open-distance.com"

## Anything else?

Coverage gaps, address-format quirks, and timing/perf issues are all welcome
here. The more specific the better — a single repro address is more useful
than "geocoding is bad in Iowa."
