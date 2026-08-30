# Changelog

All notable changes to this project. Each entry links to its full per-version file in [changelog/](changelog/).

## [0.5.0](changelog/0.5.x/0.5.0.md) — 2026-08-30 · ⚠️ Breaking

DataCanvas capability-gated tools, describe-before-query guidance, and a reduced complete-data spill schema.

## [0.4.12](changelog/0.4.x/0.4.12.md) — 2026-08-23

MCP 2026-07-28 support, explicit stateless HTTP, and accurate dataframe truncation disclosure.

## [0.4.11](changelog/0.4.x/0.4.11.md) — 2026-07-17 · 🛡️ Security

Invalid BLS_API_KEY is now reported as a configuration error instead of quota_exceeded, and redacted from all error output

## [0.4.10](changelog/0.4.x/0.4.10.md) — 2026-07-17

bls_get_series forced annual-average rows into observations[] whenever a year range was passed; annual_average is now an explicit opt-in (default false, decoupled from start_year/end_year). The mirror's queryLatest also let a year's mean win bls_get_latest via lexical period comparison; fixed via isLaterObservation().

## [0.4.9](changelog/0.4.x/0.4.9.md) — 2026-07-17

SURVEY_CAPABILITIES rebuilt from a live sweep of all 70 BLS surveys, correcting 12 wrong entries and 51 that silently defaulted to no calculation support (#39); bls_get_series now surfaces zero-observation series (#45) and canvas registration failures (#46) instead of returning silently; bls_search_series resolves CW (CPI-W) series (#51).

## [0.4.8](changelog/0.4.x/0.4.8.md) — 2026-07-17

quota_exceeded and the new request_rejected reason now fail fast instead of retrying (#48, #47); bls_get_series surfaces BLS's 3- and 6-month net/percent changes (#50); .mcpbignore excludes /.cache/, fixing an oversized .mcpb bundle (#52).

## [0.4.7](changelog/0.4.x/0.4.7.md) — 2026-07-17

Survey-catalog corrections: bls_list_surveys category map (#44), catalog harvest sa→ap Average Price fix (#43), and one canonical survey list shared by the catalog and observations ingester (#49). Adopts mcp-ts-core ^0.10.14 supply-chain hardening (minimumReleaseAge, Socket scanner, SECURITY.md); Bun 1.3.14; dependency refresh.

## [0.4.6](changelog/0.4.x/0.4.6.md) — 2026-06-20

Adopt @cyanheads/mcp-ts-core ^0.10.9 — clearer bls_dataframe_query SQL-gate errors, qualified DataCanvas describe() filters, and two new devcheck gates (floating dependency specifiers, plugin-manifest correctness). Dependency refresh; codex plugin longDescription filled.

## [0.4.5](changelog/0.4.x/0.4.5.md) — 2026-06-15

Server-level instructions on createApp() orient agents to the bls_* workflow and quota model. Plugin manifests unscope their display identity to the repo name. Dev-dependency refresh.

## [0.4.4](changelog/0.4.x/0.4.4.md) — 2026-06-12

Adopt @cyanheads/mcp-ts-core ^0.10.6: framework SQL system-catalog gate, stringbool env flags, enrich.total/truncated helpers. MCPB bundle hygiene: clean-mcpb.ts strips dependency agent-docs, lint-packaging bundle-content + identity checks. Dockerfile healthcheck + version label.

## [0.4.3](changelog/0.4.x/0.4.3.md) — 2026-06-08 · ⚠️ Breaking

BREAKING: bls_search_series output renamed (areaName→area, itemName→item, seasonal boolean→string); bls_get_latest double-list fix; dataframe-query cap notice fix; search capped flag

## [0.4.2](changelog/0.4.x/0.4.2.md) — 2026-06-04

bls_search_series: headline series union fix, concept/synonym resolution

## [0.4.1](changelog/0.4.x/0.4.1.md) — 2026-06-04

Catalog SQLite index, bls_search_series restored, OES gate

## [0.4.0](changelog/0.4.x/0.4.0.md) — 2026-06-04

Observation mirror, catalog cache, request echoes

## [0.3.1](changelog/0.3.x/0.3.1.md) — 2026-06-04

bls_get_latest result ordering fix, series_not_found contract correction, bls_list_surveys error contracts

## [0.3.0](changelog/0.3.x/0.3.0.md) — 2026-06-02

configurable BLS User-Agent via BLS_USER_AGENT; @cyanheads/mcp-ts-core ^0.9.21

## [0.2.3](changelog/0.2.x/0.2.3.md) — 2026-05-30

enrichment adoption — search/series/dataframe tools surface query echoes, result totals, and empty-result guidance

## [0.2.2](changelog/0.2.x/0.2.2.md) — 2026-05-28 · 🛡️ Security

mcp-ts-core ^0.9.9 → ^0.9.13: HTTP body cap (413 guard), session-init gate, quieter 401/403/400/404 logging, GET /mcp keywords; dep refresh

## [0.2.1](changelog/0.2.x/0.2.1.md) — 2026-05-25

Catalog load retries with linear backoff on cold-start failure; catalogLoadError surfaced in search error message.

## [0.2.0](changelog/0.2.x/0.2.0.md) — 2026-05-24 · ⚠️ Breaking

Rename: bls-mcp-server → bls-labor-mcp-server. npm, Docker, and MCP registry identifiers updated. Tool names (bls_*) unchanged.

## [0.1.9](changelog/0.1.x/0.1.9.md) — 2026-05-24

Parallel series fetches in bls_get_latest, code simplification, mcp-ts-core ^0.9.6 → ^0.9.9, skills sync.

## [0.1.8](changelog/0.1.x/0.1.8.md) — 2026-05-24

Fix bls_get_series batch error messages and canvas-unavailable handling.

## [0.1.7](changelog/0.1.x/0.1.7.md) — 2026-05-23

Add @duckdb/node-api — enables DuckDB canvas provider for dataframe tools.

## [0.1.6](changelog/0.1.x/0.1.6.md) — 2026-05-23

Field-test bug fixes: error contracts, catalog handling, survey metadata, and formatting across BLS tools.

## [0.1.5](changelog/0.1.x/0.1.5.md) — 2026-05-23

Pre-launch polish: code simplification across services and tools, README expanded with full tool docs and Docker section, Dockerfile OCI labels filled, .env.example populated, bunfig.toml added, GitHub topics synced.

## [0.1.4](changelog/0.1.x/0.1.4.md) — 2026-05-23

Field-test bug fixes: empty-obs handling, year-range validation, capability flags, catalog population, false-positive elimination, LAUS area filter.

## [0.1.3](changelog/0.1.x/0.1.3.md) — 2026-05-23

Maintenance: mcp-ts-core ^0.9.5 → ^0.9.6, LICENSE added, skills synced.

## [0.1.2](changelog/0.1.x/0.1.2.md) — 2026-05-23

Maintenance: mcp-ts-core ^0.9.5, error code semantics, MCPB bundle support.

## [0.1.1](changelog/0.1.x/0.1.1.md) — 2026-05-21

Full BLS tool surface: bls_list_surveys, bls_search_series, bls_get_series, bls_get_latest, DataCanvas dataframe tools, services, and tests.

## [0.1.0](changelog/0.1.x/0.1.0.md) — 2026-05-21

Initial scaffold and design.
