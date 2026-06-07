# Contributing to hhapi

Thanks for your interest. `hhapi` exists as a low-cost (~$5–10/mo on
Cloudflare) alternative to commercial distance-matrix APIs. Contributions
that lower the barrier — coverage, accuracy, perf, docs — are welcome.

## Setting up a fork

The repo doesn't ship pre-built data. From a clean clone:

```bash
git clone <your-fork> hhapi && cd hhapi

# 1. Prereqs (one-time on the dev machine)
brew install osmium-tool       # or your OS's equivalent
npm install                    # wrangler + types

# 2. Configuration
cp .env.example .env
# Edit .env: fill in CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID,
# OD_API_HOSTNAME, OD_API_KEY.

# 3. Provision Cloudflare resources in your account
./refresh.sh bootstrap

# 4. Materialize wrangler.toml from the template using your IDs
scripts/materialize_wrangler.sh

# 5. Populate the data (multi-hour: downloads ~50GB; builds ~30GB R2 worth of
#    tiles + ~225M-row D1 address shards + 33M-row D1 segment shards)
./refresh.sh all

# 6. Smoke test
OD_API_KEY=… bash scripts/acceptance_us.sh
```

You don't have to run `./refresh.sh all` to develop on the Worker code —
running `wrangler dev` against the production R2/D1 state works once
`wrangler.toml` is materialized.

## What kind of changes are easy to accept

- Worker code improvements that don't change the response wire format
- New address sources (the ingest pipeline is modular per source)
- Perf improvements (especially anything that reduces 30s-budget CPU usage)
- Docs, examples, additional acceptance probes
- Bug fixes with a regression test in `scripts/acceptance_us.sh`

## What needs design discussion first

Open an issue before sending a PR for:

- Changes to the Distance Matrix response shape (callers depend on it)
- New top-level endpoints
- Tile binary format changes (affects every R2 object + every Worker build)
- D1 schema changes (touches all 49 per-state shards)
- Anything that changes the address/match tier semantics

## Style

- Worker code: TypeScript, strict mode. `npx tsc --noEmit` must pass.
- ETL: Python 3.10+, no required type checker, but readable code preferred.
- Bash: BSD-compatible (no associative arrays — works on macOS stock bash 3.2).
- No emojis in code or commit messages unless explicitly part of user-facing output.
- Don't add comments that explain *what* the code does — the code does that.
  Only add comments for non-obvious *why* — workarounds, hidden constraints,
  references to upstream bugs, etc.

## GitHub Actions

For a fork to use the workflows in `.github/workflows/`, set these repository
secrets (Settings → Secrets and variables → Actions):

| Secret              | Used by              | What it holds                                |
|---------------------|----------------------|----------------------------------------------|
| `CLOUDFLARE_API_TOKEN` | `deploy.yml`       | Same token you use locally with `wrangler`   |
| `CLOUDFLARE_ACCOUNT_ID` | `deploy.yml`     | Your Cloudflare account ID                   |
| `OD_API_KEY`          | `acceptance.yml`   | The same key clients pass on `?key=`         |
| `OD_API_BASE_URL`     | `acceptance.yml` (optional) | Override the URL the probe runs against (defaults to `https://open-distance.com`) |

The data-refresh pipeline (`./refresh.sh all`) is **not** wired into Actions:
it downloads ~50 GB and runs for hours, which doesn't fit GitHub's default
runner disk/budget. Run it on your own machine or a self-hosted runner; the
spec recommends a monthly cadence.

## License

By contributing you agree your contributions are licensed under
[Apache License 2.0](LICENSE), the same terms as the rest of the project.

## Data attribution

When deploying a fork, surface the attribution required by the upstream data
sources to your end-users. See [NOTICE.md](NOTICE.md) for the canonical list
(OSM/ODbL, OpenAddresses per-source, NAD public domain, TIGER public domain).
