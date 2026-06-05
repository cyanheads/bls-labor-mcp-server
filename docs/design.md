# bls-labor-mcp-server — Design

## MCP Surface

### Tools

4 core tools + 3 dataframe tools (1 opt-in):

| Name | Description | Key Inputs | Annotations |
|:-----|:------------|:-----------|:------------|
| `bls_search_series` | Searches BLS series catalog by natural language query, survey, geographic area, or subject keywords to resolve cryptic SeriesIDs. Returns matching series with decoded components (survey, area, item, seasonal flag) and plain-language names. Use this before `bls_get_series` when you have a concept but not a SeriesID. | `query` (natural language or keyword), `survey` (enum: CPS, CES, CPI, PPI, JOLTS, LAUS, OEWS, ECEC, …), `area` (state name / MSA / FIPS), `seasonal_adjustment` (bool), `limit` | `readOnlyHint: true`, `openWorldHint: true` |
| `bls_get_series` | Fetches time-series data for 1–50 BLS series by SeriesID, with optional year range and BLS-computed period-over-period calculations. Returns observations with metadata (series name, unit, seasonality). When the total observation count exceeds the inline budget, spills to canvas and returns a `dataset` field with a `df_<id>` handle for follow-up SQL. Use when you already have SeriesIDs; use `bls_search_series` first if you don't. Calculations are a boolean flag (you can't select one type); the API returns whichever the survey supports — check `bls_list_surveys` if unsure. | `series_ids` (array, 1–50), `start_year` (int), `end_year` (int), `calculations` (bool) | `readOnlyHint: true`, `openWorldHint: true` |
| `bls_get_latest` | Returns the single most recent observation for one or more BLS series. For "what is X right now" questions — use when you need the current value, not history. Internally issues one GET request per series (no batch-latest endpoint exists in the BLS API); prefer `bls_get_series` with a 1-year window when fetching latest values for many series. | `series_ids` (array, 1–10 recommended; up to 50) | `readOnlyHint: true`, `openWorldHint: true`, `idempotentHint: true` |
| `bls_list_surveys` | Lists BLS survey programs with their codes, descriptions, and geographic/subject coverage. Use to discover which survey covers a topic before calling `bls_search_series`. | `category` (enum: prices, employment, wages, productivity, injuries, time_use — optional filter) | `readOnlyHint: true`, `openWorldHint: false`, `idempotentHint: true` |
| `bls_dataframe_describe` | List canvas dataframes materialized by `bls_get_series`, with provenance, TTL, row count, and column schema. Read-only. Requires `CANVAS_PROVIDER_TYPE=duckdb`. | `name` (optional — omit to list all) | `readOnlyHint: true`, `idempotentHint: true`, `openWorldHint: false` |
| `bls_dataframe_query` | Run a single-statement SELECT against canvas dataframes. Supports JOINs, aggregates, window functions, CTEs. Optional `register_as` persists the result as a new dataframe. Read-only: writes, DDL, DROP, COPY, PRAGMA, ATTACH, and external-file table functions are rejected. System catalogs denied at bridge layer. Requires `CANVAS_PROVIDER_TYPE=duckdb`. | `sql` (SELECT statement), `register_as` (optional), `preview` (optional row count), `row_limit` (default 1000, max 10000) | `readOnlyHint: true`, `idempotentHint: true`, `openWorldHint: false` |
| `bls_dataframe_drop` _(opt-in)_ | Drop a canvas dataframe by name. Idempotent. Opt-in via `BLS_DATAFRAME_DROP_ENABLED=true` — off by default since per-table TTL handles cleanup. | `name` (df_<id> to drop) | `readOnlyHint: false`, `idempotentHint: true`, `openWorldHint: false`, `destructiveHint: true` |

### `bls_dataframe_describe` / `bls_dataframe_query` / `bls_dataframe_drop`

In-conversation SQL analytics over the dataframes that `bls_get_series` materializes on a shared DuckDB-backed canvas. When `bls_get_series` spills, the response includes a `dataset` field with a `df_<id>` handle; pass that handle to `bls_dataframe_query` for JOINs, GROUP BY area/industry, window functions (rolling avg, YoY computed locally rather than relying on BLS's `calculations` flag).

- **Read-only by default.** Writes, DDL, DROP, COPY, PRAGMA, ATTACH, and external-file table functions are rejected by the framework SQL gate. System catalogs (`information_schema`, `pg_catalog`, `sqlite_master`, `duckdb_*`) are denied at the bridge layer so callers can't enumerate dataframes they don't already hold a handle for. `bls_dataframe_drop` is the only destructive tool and is opt-in (`BLS_DATAFRAME_DROP_ENABLED=true`); TTL handles cleanup otherwise.
- **Per-table TTL.** Each dataframe ages on its own clock (default 24 h, override with `BLS_DATASET_TTL_SECONDS`). The canvas itself uses the framework's sliding TTL.
- **`register_as` chaining.** `bls_dataframe_query` can persist its result as a new dataframe with a fresh TTL — chain analyses without re-running the source query or consuming additional BLS API quota.
- **`bls_get_series` output schema.** When spillover occurs, the response includes `dataset: { name: "df_<id>", row_count: N, truncated: bool }`. Pass `name` directly to `bls_dataframe_query` as the table name in the SELECT. When no spillover occurs, `dataset` is absent.

### Resources

None — all data is dynamic (time series by definition). Tool surface is self-sufficient.

### Prompts

None. Read-only research server; no recurring interaction patterns warrant a structured prompt template.

---

## Overview

`bls-labor-mcp-server` wraps the Bureau of Labor Statistics public API (v2), exposing US labor, price, productivity, and employment data. The BLS is the primary source for CPI, unemployment, wages, JOLTS, PPI, occupational employment, and related statistics — predating and often more current than republished FRED series.

The core UX problem is SeriesID resolution: BLS identifiers (`LNS14000000`, `CES0000000001`) encode survey + area + item + seasonal flag in opaque positional codes. `bls_search_series` is the anchor tool — it translates human concepts into SeriesIDs so the other tools can operate.

---

## Requirements

- BLS API v2 endpoint (`https://api.bls.gov/publicAPI/v2/`); `BLS_API_KEY` env var required for v2 access
- 500 queries/day per API key; 50 series per request; up to 20 years history per request
- Read-only access — BLS API has no write endpoints
- SeriesID catalog sourced from LABSTAT flat files at `download.bls.gov/pub/time.series/{survey}/` — one `{survey}.series` file + code-mapping files per survey (e.g., `cu.series` = 1.3MB, `ce.series` = 3.9MB, `ln.series` = 15MB). Only the `{survey}.series` and `{survey}.map` files are needed, not the `{survey}.data.*` observation files (those are hundreds of MB). Download and bundle at build time; total series-index footprint is estimated 50–100MB across all ~60 surveys; `bls_search_series` operates entirely offline against this index
- Period-over-period calculations via BLS v2 `calculations: true` boolean; a single flag (you cannot select an individual calculation type), but the API returns whichever the survey supports — each survey's `allowsNetChange` / `allowsPercentChange` fields (from `GET /surveys/{abbr}`) indicate which, and a survey supporting neither returns an error
- `api-canvas` / DataCanvas available for tabular spillover when series count × observation count exceeds context budget

---

## Services

| Service | Wraps | Used By |
|:--------|:------|:--------|
| `BlsApiService` | BLS API v2 (`POST /timeseries/data`, `GET /timeseries/data/{id}?latest=true`, `GET /surveys`, `GET /surveys/{abbr}`) | `bls_get_series`, `bls_get_latest`, `bls_list_surveys` |
| `BlsCatalogService` | LABSTAT flat files (`{survey}.series` + map files from `download.bls.gov/pub/time.series/`) | `bls_search_series` |
| `BlsObservationsService` | Optional LABSTAT observation mirror (`{survey}.data.*` → embedded SQLite via framework `defineMirror`); opt-in, default off | `bls_get_series`, `bls_get_latest` (when `BLS_OBSERVATIONS_MIRROR_ENABLED=true` and the mirror is ready) |
| `CanvasBridgeService` | Framework `DataCanvas` — `df_<id>` minting, all-nullable schema derivation, per-table TTL bookkeeping, bridge-layer system-catalog SQL denial | `bls_get_series` (register on spillover), `bls_dataframe_describe`, `bls_dataframe_query`, `bls_dataframe_drop` |

**`BlsApiService` resilience:**

| Concern | Decision |
|:--------|:---------|
| Retry boundary | Full fetch + parse pipeline; use `withRetry` |
| Backoff | 1–2s base (rate-limited upstream, 500/day quota makes aggressive retries counterproductive) |
| 429 handling | Count against daily quota; surface remaining quota estimate in response metadata |
| Parse failure | HTML error page detection → `ServiceUnavailable`, not `SerializationError` |

**`BlsCatalogService`:** BLS LABSTAT publishes per-survey flat files at `download.bls.gov/pub/time.series/{survey}/`. The relevant files are `{survey}.series` (series-level index: seriesID, title, area, item, seasonal flag) and the survey's code-mapping files (e.g., `cu.area`, `cu.item`). The catalog index needs only `{survey}.series` + the code-map files — not the hundreds-of-MB `{survey}.data.*` observation files (those are ingested separately by the optional `BlsObservationsService` mirror, off by default). Series + map files are fetched at startup and indexed into an on-disk SQLite store (`BLS_CATALOG_DB_PATH`, FTS5-backed) — queried on demand rather than held in memory, so large surveys do not inflate the heap, and the index survives restarts. Search narrows candidates via FTS5 then applies a bespoke relevance rescore. The OES/OEWS wage survey (~6M series / ~1.2 GB) is excluded unless `BLS_CATALOG_INCLUDE_OES=true`. Enables full-text + structured search with zero API quota cost. Re-harvest on a TTL or on demand. The BLS FAQ explicitly notes there is no API catalog endpoint ("We do not currently have a catalogue of series IDs"), confirming the offline approach is the only path.

**`bls_list_surveys` backed by API:** `GET /surveys` returns all survey abbreviations and names; `GET /surveys/{abbr}` returns `allowsNetChange`, `allowsPercentChange`, `hasAnnualAverages`. This is a low-frequency call and can be cached aggressively (monthly TTL); it does not count toward the 500/day quota concern.

---

## Config

| Env Var | Required | Description |
|:--------|:---------|:------------|
| `BLS_API_KEY` | Yes | BLS v2 API key (free, register at bls.gov/developers) |
| `BLS_BASE_URL` | No | Override API base URL (default: `https://api.bls.gov/publicAPI/v2`) |
| `BLS_CATALOG_BASE_URL` | No | Override LABSTAT flat-file base URL (default: `https://download.bls.gov/pub/time.series`) — useful for pointing at a local mirror |
| `BLS_CATALOG_DB_PATH` | No | On-disk SQLite catalog index, queried on demand and persisted across restarts; empty uses an in-memory DB. Default `.cache/bls-catalog.db`. |
| `BLS_CATALOG_CACHE_TTL_HOURS` | No | Catalog freshness window in hours — re-harvest once older. Default `168` (7 days). |
| `BLS_CATALOG_INCLUDE_OES` | No | Include the OES/OEWS wage survey (~6M series / ~1.2 GB). Default `false`; OES stays fetchable by ID. |
| `BLS_OBSERVATIONS_MIRROR_ENABLED` | No | Serve observations from the local SQLite mirror instead of the live API. Default `false`. Requires a one-time bootstrap. |
| `BLS_OBSERVATIONS_MIRROR_PATH` | No | SQLite store path for the observation mirror. Default `.mirror/bls-observations.db`. |
| `BLS_OBSERVATIONS_MIRROR_REFRESH_CRON` | No | Incremental refresh schedule (HTTP transport only). Default `0 6 * * 1` (Mon 06:00 UTC). |
| `BLS_OBSERVATIONS_MIRROR_FALLBACK_LIVE` | No | Fall back to the live API when the mirror is not ready or a series is missing. Default `true`. |
| `CANVAS_PROVIDER_TYPE` | No | Set to `duckdb` to enable DataCanvas tabular spillover and dataframe tools (Node only; Cloudflare Workers fail closed). Default `none`. |
| `BLS_DATASET_TTL_SECONDS` | No | Per-table TTL for canvas-registered dataframes. Sliding window touched on every dataframe op. Default `86400` (24 h). |
| `BLS_DATAFRAME_DROP_ENABLED` | No | Set to `true` to expose `bls_dataframe_drop`. Off by default — TTL handles cleanup. |

---

## Implementation Order

1. **Config** — `src/config/server-config.ts` with Zod schema; validate `BLS_API_KEY` at startup
2. **`BlsCatalogService`** — bundle/download BLS flat catalog files; build in-memory series index; implement text + structured search
3. **`BlsApiService`** — v2 `POST /timeseries/data` (batch) and `GET /timeseries/data/{id}?latest=true` (single) wrappers with retry/backoff; `GET /surveys` for survey metadata
4. **`bls_list_surveys`** — static catalog; no API calls; independently testable
5. **`bls_search_series`** — backed by `BlsCatalogService`; no API calls; test against real catalog
6. **`bls_get_latest`** — single API call path; simple response shape; test first
7. **`bls_get_series`** — batch series with year range, calculations, and DataCanvas spillover; `dataset` field in output when spilled
8. **`CanvasBridgeService`** — `df_<id>` minting, schema derivation, per-table TTL, system-catalog denial; mirrors `src/services/canvas-bridge/` from secedgar
9. **Dataframe tools** — `bls_dataframe_describe`, `bls_dataframe_query`, `bls_dataframe_drop` (gate on `BLS_DATAFRAME_DROP_ENABLED`)

Each step is independently testable.

---

## Domain Mapping

| Noun | BLS Operations | Tool |
|:-----|:--------------|:-----|
| Survey catalog | List surveys/programs | `bls_list_surveys` |
| Series catalog | Search by text/filters | `bls_search_series` |
| Time series | Fetch by ID + year range | `bls_get_series` |
| Latest value | Fetch most recent period | `bls_get_latest` |

BLS v2 endpoints used:
- `POST /timeseries/data` — batch fetch 1–50 series with year range and optional `calculations: true`
- `GET /timeseries/data/{seriesID}?latest=true` — latest single-observation per series (one request per seriesID; no batch equivalent)
- `GET /surveys` — list all survey abbreviations and names
- `GET /surveys/{abbr}` — survey metadata including `allowsNetChange`, `allowsPercentChange`, `hasAnnualAverages`

Series catalog resolution is handled entirely offline from LABSTAT flat files — no API quota consumed.

### Error Contracts

| Tool | reason | code | when | retryable? |
|:-----|:-------|:-----|:-----|:-----------|
| `bls_get_series`, `bls_get_latest` | `quota_exceeded` | `ServiceUnavailable` | 429 from API or daily 500-query limit hit | No (until next UTC day) |
| `bls_get_series`, `bls_get_latest` | `series_not_found` | `InvalidParams` | API returns "Series does not exist" message | No — fix the SeriesID |
| `bls_get_series`, `bls_get_latest` | `series_locked` | `ServiceUnavailable` | API returns "Database is locked for Series" | Yes — transient, retry with backoff |
| `bls_get_series` | `no_data_for_period` | `InvalidParams` | API returns "No Data Available for Series" for the requested year range | No — adjust `start_year`/`end_year` |
| `bls_get_series` | `calculations_not_supported` | `InvalidParams` | `calculations: true` requested for a survey that doesn't support it | No — remove calculations flag |
| `bls_search_series` | `catalog_unavailable` | `InternalError` | Catalog index not loaded (startup failure or build-time skip) | No — server restart needed |
| `bls_dataframe_describe`, `bls_dataframe_query`, `bls_dataframe_drop` | `canvas_unavailable` | `ServiceUnavailable` | `CANVAS_PROVIDER_TYPE` is not `duckdb` | No — set env var and restart |

---

## Workflow Analysis

**Common agent chain — natural language → current value:**

| # | Tool | Purpose |
|:--|:-----|:--------|
| 1 | `bls_list_surveys` | Orient to which survey covers the topic (optional; skip if domain is clear) |
| 2 | `bls_search_series` | Resolve concept → SeriesID(s) |
| 3 | `bls_get_latest` | Get current value for resolved SeriesID(s) |

**Common agent chain — trend analysis:**

| # | Tool | Purpose |
|:--|:-----|:--------|
| 1 | `bls_search_series` | Resolve concept → SeriesID(s) |
| 2 | `bls_get_series` | Fetch history with `calculations: true` for YoY/MoM |

`bls_get_series` is the quota-heavy tool (one API call per batch, counts as one query). `bls_get_latest` issues N individual GET requests (one per seriesID) — each counts as one query. For "current value" across many series, `bls_get_series` with a 1-year window is more quota-efficient (one query regardless of series count); `bls_get_latest` is preferable only for a single series where the absolute most recent period matters.

**Common agent chain — multi-series SQL analytics (dataframe path):**

| # | Tool | Purpose |
|:--|:-----|:--------|
| 1 | `bls_search_series` | Resolve concepts → SeriesIDs across surveys or areas |
| 2 | `bls_get_series` | Batch-fetch 1–50 series; result spills to canvas → `dataset: df_<id>` when large |
| 3 | `bls_dataframe_describe` | Confirm schema and column names before writing SQL (optional) |
| 4 | `bls_dataframe_query` | JOIN multiple `df_<id>` tables, GROUP BY area/industry, apply window functions (rolling avg, YoY) — canvas SQL counts zero against BLS quota |
| 5 | `bls_dataframe_query` + `register_as` | Persist an intermediate result as a new dataframe to chain further analysis without re-running source SQL |

Canvas SQL is quota-free — only the upstream `bls_get_series` call counts against the 500/day limit. This makes canvas the right path for cross-series JOINs and rolling-window computations, especially when BLS's `calculations: true` flag is insufficient (e.g., trailing-12-month average, area-level variance).

### Output and format() Completeness

Both `bls_get_series` and `bls_get_latest` return structured data that must appear in full in both `structuredContent` (Claude Code) and the `format()` markdown twin (Claude Desktop). The `format()` implementation must render all observation values, not just a count or summary. `bls_search_series` similarly must render decoded series components (survey, area, item, seasonal flag, plain-language name) in `format()` — not just a count of matches.

---

## Known Limitations

- **500 queries/day per API key.** `bls_get_series` (POST, up to 50 series) consumes one query regardless of series count. `bls_get_latest` issues one GET per seriesID — fetching 10 series' latest values costs 10 queries. At scale this is the binding constraint; prefer `bls_get_series` with a narrow year window for multi-series latest-value needs. Response metadata surfaces an estimated remaining quota when the API returns it. Multi-tenant hosted deployments need per-tenant key support or a quota-sharing strategy outside this server's scope.
- **20-year history window.** BLS v2 caps history at 20 years per request. Longer time series require multiple calls.
- **SeriesID catalog freshness.** The bundled catalog reflects BLS flat files at build time. New series or geographic area changes won't appear until a rebuild. `bls_search_series` may miss very recently added series.
- **No geographic geocoding.** Area code resolution maps string names to BLS FIPS/area codes from the catalog — it's a lookup, not a geocoder. Unusual MSA names or abbreviations may not match.
- **Calculations are BLS-server-side, requested via a single flag.** `calculations: true` requests both net change and percent change — individual types cannot be selected — but the API returns whichever the survey supports (CPI/PPI return percent change only, with no error). The `allowsNetChange`/`allowsPercentChange` fields from the surveys API indicate per-survey support. A survey that supports neither returns an error rather than silently ignoring the flag.
- **Dataframe tools require `CANVAS_PROVIDER_TYPE=duckdb`.** DuckDB has no V8-isolate build; setting this on Cloudflare Workers fails closed with a `ConfigurationError` at init time. Node.js only. When canvas is disabled, all three dataframe tools throw `canvas_unavailable` (`ServiceUnavailable`).

---

## Decisions Log

### Answered questions

- **Curated lookup table vs. search-only for SeriesID resolution** → offline catalog search from BLS flat files, with a curated "common series" shortlist embedded in the index for high-frequency queries (unemployment rate, CPI-U, nonfarm payrolls). The flat files cover everything; the shortlist just improves ranking for known-common asks. No separate lookup table tool needed.
- **Calculations: BLS flag vs. local computation** → BLS v2 `calculations` flag. One fewer moving part, always consistent with BLS's published numbers. Local computation adds complexity with no fidelity gain for the use cases here.
- **Area-code resolution: separate tool vs. fold into `bls_search_series`** → fold into `bls_search_series` as an `area` parameter. It's a filter, not a workflow step — a dedicated area-lookup tool would just be a pre-step agents forget to use. The search tool accepts state name, MSA, or FIPS and resolves internally.
- **`bls_get_latest` vs. collapsing into `bls_get_series`** → kept as a separate tool. The "current value" ask is extremely common, the call is cheaper in user-cognitive overhead, and the description signals clearly when to use it vs. history. A `mode` consolidation would obscure the choice.
- **DataCanvas opt-in** → `CANVAS_PROVIDER_TYPE=duckdb` env var following framework convention. Activated in `bls_get_series` when series × observation count would overflow context. `bls_get_latest` never spills — result set is always bounded.
- **v1 vs. v2 API** → v2 only. v1 requires no key but has severe throttling (10 series/request, no calculations flag). The server should require a key and get full v2 capability.
- **Prompts** → none. BLS queries are factual lookups; there's no recurring LLM-interaction pattern that benefits from a template.

- **Why expose dataframe tools at all?** `bls_get_series` can return up to 50 series × 20 years × 12 months = 12,000 observations in a single call. That's comfortably within context for a few series but blows it for broad multi-survey fetches. More importantly, the interesting economic analysis (seasonal decomposition, cross-survey JOIN, geographic variance, rolling averages) requires arbitrary SQL — something `bls_get_series` can never provide inline. Canvas SQL is quota-free; only the upstream fetch counts against the 500/day limit.
- **Why opt-in drop?** Per-table TTL (default 24 h) handles lifecycle for normal use. Making drop always-on would give agents a destructive tool they don't need in the common case; opt-in preserves the read-only posture for deployments that don't need early cleanup.
- **Why expose `register_as` chaining in `bls_dataframe_query`?** Without it, every derived analysis (e.g., "compute 12-month rolling avg, then JOIN that with JOLTS data") requires re-running the full source SQL each time. `register_as` lets the agent materialize an intermediate step as a named dataframe with a fresh TTL, enabling multi-hop analyses within a session.
- **How does this interact with BLS's 500/day quota?** Canvas SQL operations (`bls_dataframe_describe`, `bls_dataframe_query`, `bls_dataframe_drop`) make no BLS API calls — zero quota consumed. The quota gate is at `bls_get_series` and `bls_get_latest`. Once data is on canvas, agents can run unlimited SQL against it without touching quota.

### Options declined

- **`bls_decode_series_id` tool** → declined. Decoding is better done as enriched output in `bls_search_series` results (return the decoded components alongside the ID). A standalone decode tool adds a round-trip for no workflow benefit.
- **`bls_compare_series` tool** → declined. Cross-series comparison is arithmetic the agent can do from `bls_get_series` output. A dedicated comparison tool would be pure wrapper around data the agent already has.
- **App tool for tabular results** → declined. No MCP Apps-capable client justification; DataCanvas via `api-canvas` handles the spillover case without the iframe/CSP/format-twin maintenance cost.
- **Resources** → declined. BLS data is time-dynamic by nature (series values change monthly). There's no stable-URI, cacheable, injectable-context use case that tools don't already serve.
- **Per-tenant quota accounting built into the server** → deferred. The 500/day limit is real but the server can't track cross-session usage without external state. Surfacing remaining quota from API responses (when available) is the right scope; full accounting is a deployment concern.

---

### Post-design corrections (verified against BLS API docs and LABSTAT)

- **`calculations` is a boolean, not an enum.** The initial design listed `calculations` as `enum: none, net_change, percent_change, all`. The actual BLS v2 API accepts `"calculations": true|false` only — an individual calculation type cannot be selected. The API returns whichever the survey supports (CPI/PPI return percent change only). The tool parameter is a `bool`, and per-survey support is indicated by `allowsNetChange`/`allowsPercentChange`.
- **No batch-latest endpoint exists.** The design's `timeseries/latest` POST endpoint does not exist in BLS v2. The actual endpoint is `GET /timeseries/data/{seriesID}?latest=true`, which accepts a single seriesID per request. `bls_get_latest` must issue N sequential (or parallel) GETs, each consuming one of the 500/day queries. Corrected tool description, quota note, and workflow analysis accordingly.
- **LABSTAT flat files are real and downloadable.** Confirmed at `download.bls.gov/pub/time.series/`. Each survey directory contains `{survey}.series` (the series index, sizes range from ~100KB to 15MB) and code-mapping files. The `{survey}.data.*` observation files (hundreds of MB each) are NOT needed for catalog search and must be excluded from the build-time download. Total series-index footprint estimated at 50–100MB across all surveys.
- **BLS has no API catalog search.** FAQ explicitly confirms: "We do not currently have a catalogue of series IDs." The offline flat-file approach is the correct workaround (and the only one).
- **`bls_list_surveys` can use live API endpoints.** `GET /surveys` and `GET /surveys/{abbr}` return live survey metadata including calculation support flags. Moved `bls_list_surveys` to `BlsApiService` with aggressive caching (monthly TTL). Does not consume meaningful quota.
- **Error contracts added.** Typed `errors` contract declared for: quota exhaustion, invalid SeriesID, locked database, no data for period, calculations not supported, catalog unavailable.
- **`format()` completeness callout added.** All three data-returning tools must render their full observation data in `format()`, not just summaries — Claude Desktop sees only `content[]`.
