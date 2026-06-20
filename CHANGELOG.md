# Changelog

All notable changes to this project. Each entry links to its full per-version file in [changelog/](changelog/).

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
