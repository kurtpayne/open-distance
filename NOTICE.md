# Third-party data and attribution

`hhapi` is built entirely from open data. None of the following data is
distributed by this repository — `refresh.sh` downloads it on demand to a
local `data/` directory which is `.gitignore`-d. Operators of forked
deployments are responsible for displaying the relevant attribution to
end-users of their service.

## Road network

**OpenStreetMap** — via [Geofabrik](https://download.geofabrik.de/) per-state
extracts. Source data licensed under the [Open Database License
(ODbL)](https://opendatacommons.org/licenses/odbl/1-0/).

Required attribution when used:

> © OpenStreetMap contributors. Map data available under the
> [Open Database License](https://opendatacommons.org/licenses/odbl/).

The road graph tiles we build from this data (stored in R2 at
`tiles/<version>/...`) are a *derived database* under ODbL. Operating an
API service on top of them is fine. Redistributing the tile binaries
directly (e.g. as a downloadable dataset) carries ODbL's share-alike
obligation: derived databases must be made available under ODbL, with
attribution and the same license terms.

## Addresses — primary

**NAD (National Address Database)** — U.S. Department of Transportation.
Public domain (17 U.S.C. § 105 — federal government work). No
attribution required, but providing one is appreciated.

> Address data provided by the U.S. DOT National Address Database.

**OpenAddresses** — per-source per-county/per-city authorities, aggregated
at [batch.openaddresses.io](https://batch.openaddresses.io/). Each source
carries its own attribution; the OA project publishes a machine-readable
manifest with per-source license terms.

When redistributing the address point data itself, downstream consumers
must honor the per-source attribution. Operating a service that returns
geocoded points or normalized addresses does not trigger per-source
distribution requirements, but a blanket attribution line is good practice:

> Address data from [OpenAddresses](https://openaddresses.io/), used under
> the per-source terms documented at openaddresses.io.

## Addresses — supplementary

**OpenStreetMap `addr:*` nodes** — same ODbL terms as the road network
attribution above.

## Street segments (for address interpolation)

**TIGER/Line 2024** — U.S. Census Bureau. Public domain. No attribution
required.

> Street segment data from the U.S. Census Bureau TIGER/Line 2024 release.

## Code

The source code in this repository is licensed under the
[Apache License, Version 2.0](LICENSE). See `LICENSE` for the full text.

Copyright (c) 2026 Kurt Payne and contributors.
