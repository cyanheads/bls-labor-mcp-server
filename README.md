<div align="center">
  <h1>@cyanheads/bls-labor-mcp-server</h1>
  <p><b>Fetch US Bureau of Labor Statistics data — CPI, unemployment, wages, JOLTS, and more via MCP. STDIO or Streamable HTTP.</b>
  <div>6 Tools by default · 7 with opt-in drop</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.7.0-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/bls-labor-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.4.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/bls-labor-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/bls-labor-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.4-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/bls-labor-mcp-server/releases/latest/download/bls-labor-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=bls-labor-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvYmxzLWxhYm9yLW1jcC1zZXJ2ZXIiXSwiZW52Ijp7IkJMU19BUElfS0VZIjoieW91ci1hcGkta2V5In19) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22bls-labor-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Fbls-labor-mcp-server%22%5D%2C%22env%22%3A%7B%22BLS_API_KEY%22%3A%22your-api-key%22%7D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

<div align="center">

**Public Hosted Server:** [https://bls-labor.caseyjhand.com/mcp](https://bls-labor.caseyjhand.com/mcp)

</div>

---

## Overview

US labor statistics from the Bureau of Labor Statistics: jobs, unemployment, wages, and inflation. Find series in plain language instead of decoding SeriesIDs, pull full history or the latest value, and run SQL over large multi-series results.

### Tools

| Tool | Description |
|:-----|:------------|
| `bls_list_surveys` | List BLS survey programs (CPI, CPS, CES, JOLTS, PPI, OEWS, …) with codes, descriptions, and calculation-support flags. |
| `bls_search_series` | Search the BLS series catalog by natural language, survey, area, or keywords to resolve cryptic SeriesIDs. |
| `bls_get_series` | Fetch time-series data for 1–50 BLS series by SeriesID, with optional year range and period-over-period calculations. |
| `bls_get_latest` | Return the single most recent observation for one or more BLS series. |
| `bls_dataframe_describe` | List canvas dataframes registered by `bls_get_series` or `bls_dataframe_query` — provenance, TTL, row count, column schema. Unavailable when `CANVAS_PROVIDER_TYPE=none`. |
| `bls_dataframe_query` | Run a SELECT against canvas dataframes registered by `bls_get_series` or an earlier `register_as`. Supports JOINs, aggregates, window functions, CTEs. Unavailable when `CANVAS_PROVIDER_TYPE=none`. |
| `bls_dataframe_drop` | Drop a canvas dataframe by name. Available when `BLS_DATAFRAME_DROP_ENABLED=true`, unless `CANVAS_PROVIDER_TYPE=none`; TTL handles cleanup by default. |

## Capability reference

### `bls_list_surveys` <sub>tool</sub>

- Optional `category` filters survey programs by subject; returns codes, names, and calculation-support flags (`allowsNetChange`, `allowsPercentChange`, `hasAnnualAverages`). Each row's `searchCoverage` (`indexed`, `composed`, or `none`) says whether `bls_search_series` reaches the survey, with `seriesIndexed` for indexed ones.
- Backed by the BLS surveys API with 30-day process-local caching. Annual-average support is advisory; read `bls_get_series`'s `annualAverageRows` for the rows actually returned.

---

### `bls_search_series` <sub>tool</sub>

- Search by text or SeriesID, with optional `survey`, `area`, and `seasonal_adjustment`; blank filters are omitted. `area` takes a USPS or 2-digit FIPS state code; a 3-, 4-, 5-, or 7-digit CSA, CPI area, county or CBSA, or state + place code; otherwise a substring of area, title, or SeriesID (all-digit values outside those lengths add a notice). `limit` defaults to 10 and requests above 50 clamp to 50 with notice, with `offset` pagination. Exact SeriesIDs rank first, then series matching every query word, with any place the query names in full ahead of the rest; at equal score, current series rank first, then national ones, then the JOLTS aggregate.
- Returns decoded SeriesIDs, titles, `frequency`, and independently optional `startYear`, `endYear`, and `endPeriod` coverage (for example, `1982–2005 Q04`). Coverage describes the catalog snapshot, not continuous observations. Follow `nextOffset` while `truncated` is true; `capped: true` makes `totalCount` a lower bound, and paging stops at the FTS candidate pool.
- Searches the offline LABSTAT index without using API quota; OE/OEWS is opt-in through `BLS_CATALOG_INCLUDE_OES`. Under `survey: "OE"` without those rows, it composes OEWS SeriesIDs from the OE code tables, up to 50 per search; each is marked `composed: true` and is unconfirmed until `bls_get_series` returns data for it. Unindexed surveys remain fetchable by SeriesID.

---

### `bls_get_series` <sub>tool</sub>

- Fetch up to 25 SeriesIDs without an API key or 50 with one per call, with a `start_year`/`end_year` window of up to 20 years, optional `calculations`, and `annual_average`. A start alone resolves the end to the current year capped at start + 19; an end alone is rejected. One batch consumes one API query; calculations depend on survey support (CPI/PPI return percent change only).
- Returns local-catalog titles when available and optional BLS `measure` metadata, and observations with `available`; preserves the raw `-` missing-value sentinel, and keeps valid series in mixed batches. Enrichment reports the applied year window, calculations actually returned, annual-summary rows, and any upstream reductions or advisories.
- SeriesIDs are trimmed, uppercased, and deduplicated before the cap; `unprocessedSeriesIds` lists the exact ordered remainder without automatic extra batches. Omitted year bounds use BLS's three-calendar-year default, subject to coverage.
- Large results spill to `dataset.name`. With `CANVAS_PROVIDER_TYPE=none`, all fetched observations return inline.

---

### `bls_get_latest` <sub>tool</sub>

- Fetch the latest observation for up to 50 SeriesIDs (recommended ≤10). IDs are trimmed, uppercased, and deduplicated before the cap; `unprocessedSeriesIds` lists the exact ordered remainder. Each processed ID consumes one API query; use `bls_get_series` for a more efficient multi-series batch.
- Returns successful `results[]` beside per-series `failed[]` entries. `latestObservation.available` distinguishes a published value from BLS's missing-value sentinel.

---

### `bls_dataframe_describe` <sub>tool</sub>

- Optional `name` describes one registered dataframe; omit it to list active dataframes for the tenant. Unavailable when `CANVAS_PROVIDER_TYPE=none`.
- Returns source tool, query params, row count, TTL (`created_at`/`expires_at`, fixed at table creation), and `column_schema`; BLS columns are nullable. Registered-query types outside the canvas set (`DECIMAL`, `HUGEINT`, `SMALLINT`, lists) report as `VARCHAR`. Expired entries are removed when their canvas drop succeeds.

---

### `bls_dataframe_query` <sub>tool</sub>

- Run one SELECT against registered tables, with JOINs, aggregates, window functions, or CTEs. `row_limit` defaults to 1000; larger values clamp to 10000, and `preview` clamps to the applied row limit with requested/applied notices. Zero preview remains valid; writes, external-file reads, and system catalogs are denied.
- Engine-setting functions (`current_setting`, `current_schema`, `current_schemas`, `in_search_path`) and `query_table` are denied. Unqualified `current_schema` keyword or column references are also denied; qualify a real column with its table alias (for example, `t.current_schema`). `query()` accepts one plain SQL string literal, checked recursively up to four levels; computed SQL strings are rejected. Reference staged tables directly for analysis.
- Returns rows without consuming BLS API quota. Optional `register_as` stages the result with a fresh TTL for chained analysis. Unavailable when `CANVAS_PROVIDER_TYPE=none`.

---

### `bls_dataframe_drop` <sub>tool</sub>

- Required `name` identifies the dataframe to drop. Available only with `BLS_DATAFRAME_DROP_ENABLED=true`, and never with `CANVAS_PROVIDER_TYPE=none`; TTL handles cleanup by default.
- Returns `dropped: false` for a missing table. A failed drop returns retryable `canvas_drop_failed` and leaves the dataframe registered.

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

BLS-specific:

- BLS API v2 client with retry/backoff and daily quota tracking
- Offline series catalog search against LABSTAT flat files, indexed as an on-disk SQLite/FTS5 store — zero API quota for discovery; the OES/OEWS wage survey (~6M series) is opt-in via `BLS_CATALOG_INCLUDE_OES`
- Typed error contracts for BLS-specific failure modes — quota exhaustion, locked database, calculations not supported
- Period-over-period net/percent-change calculations via BLS's own server-side flag, consistent with BLS's published numbers
- DataCanvas spillover (DuckDB, on by default) for large multi-series result sets — schema discovery and SQL access without re-querying the API

Agent-friendly output:

- Provenance — canvas-spilled results carry a `dataset.name` handle plus row count and expiry; `bls_search_series` echoes `effectiveQuery`, `catalogSize`, and whether the FTS candidate pool was `capped`
- Graceful partial failure — `bls_get_latest` returns per-item `failed[]` (seriesId + error) alongside successful `results[]` instead of failing the whole batch; `bls_get_series` keeps valid series when another SeriesID in the same batch is invalid or empty
- Discriminated outputs — every observation carries an `available` boolean for BLS's `-` missing-value sentinel, so callers branch on a typed field instead of parsing raw values
- Actionable notices — `enrichment.notice` explains empty results, canvas spillover, and unavailable data with concrete next steps (e.g. using `bls_search_series` to verify a SeriesID)

## Getting started

### Public Hosted Instance

A public instance is available at `https://bls-labor.caseyjhand.com/mcp` — no installation required. Point any MCP client at it via Streamable HTTP:

```json
{
  "mcpServers": {
    "bls-labor-mcp-server": {
      "type": "streamable-http",
      "url": "https://bls-labor.caseyjhand.com/mcp"
    }
  }
}
```

### Self-Hosted / Local

Add the following to your MCP client configuration file. A free BLS API key unlocks 500 queries/day — register at [bls.gov/developers](https://www.bls.gov/developers/home.htm). The server works without a key at 25 req/day.

```json
{
  "mcpServers": {
    "bls-labor-mcp-server": {
      "type": "stdio",
      "command": "bunx",
      "args": ["@cyanheads/bls-labor-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info",
        "BLS_API_KEY": "your-key-here"
      }
    }
  }
}
```

Or with npx (no Bun required):

```json
{
  "mcpServers": {
    "bls-labor-mcp-server": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@cyanheads/bls-labor-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info",
        "BLS_API_KEY": "your-key-here"
      }
    }
  }
}
```

Or with Docker:

```json
{
  "mcpServers": {
    "bls-labor-mcp-server": {
      "type": "stdio",
      "command": "docker",
      "args": ["run", "-i", "--rm", "-e", "MCP_TRANSPORT_TYPE=stdio", "-e", "BLS_API_KEY=your-key-here", "ghcr.io/cyanheads/bls-labor-mcp-server:latest"]
    }
  }
}
```

For Streamable HTTP, set the transport and start the server:

```sh
MCP_TRANSPORT_TYPE=http MCP_SESSION_MODE=stateless MCP_HTTP_PORT=3010 BLS_API_KEY=... bun run start:http
# Server listens at http://localhost:3010/mcp
```

### Prerequisites

- [Bun v1.4.0](https://bun.sh/) or higher (or Node.js v24+).
- A free BLS API v2 key — register at [bls.gov/developers](https://www.bls.gov/developers/home.htm). Grants 500 queries/day; the server also works without a key at 25 req/day.

### Installation

1. **Clone the repository:**

```sh
git clone https://github.com/cyanheads/bls-labor-mcp-server.git
```

2. **Navigate into the directory:**

```sh
cd bls-labor-mcp-server
```

3. **Install dependencies:**

```sh
bun install
```

4. **Configure environment:**

```sh
cp .env.example .env
# edit .env and set BLS_API_KEY
```

## Configuration

All configuration is validated at startup via Zod schemas in `src/config/server-config.ts`.

| Variable | Description | Default |
|:---------|:------------|:--------|
| `BLS_API_KEY` | BLS v2 API key. Optional — 25 req/day without, 500 req/day with. Register free at [bls.gov/developers](https://www.bls.gov/developers/home.htm). | — |
| `BLS_BASE_URL` | BLS API v2 base URL. | `https://api.bls.gov/publicAPI/v2` |
| `BLS_CATALOG_BASE_URL` | LABSTAT flat-file base URL. Override to point at a local mirror. | `https://download.bls.gov/pub/time.series` |
| `BLS_CATALOG_DB_PATH` | On-disk SQLite catalog index — queried on demand and persisted across restarts. Empty uses an in-memory DB (re-harvested each boot). Mount a volume here in containers. | `.cache/bls-catalog.db` |
| `BLS_CATALOG_CACHE_TTL_HOURS` | Per-survey catalog freshness window in hours — a survey re-harvests once its last success is older, and a failed survey's retry backoff is capped at this many hourly checks. Checked at startup and hourly while running. | `168` (7 days) |
| `BLS_CATALOG_INCLUDE_OES` | Include the OES/OEWS wage survey (~6M series / ~1.26 GB; Bun-only; multi-minute first harvest). Off by default — OES series stay fetchable by ID, and search composes them from the small OE code tables. | `false` |
| `BLS_OBSERVATIONS_MIRROR_ENABLED` | Serve observations from a local SQLite mirror instead of the live API (requires a one-time bootstrap — see below). | `false` |
| `BLS_DATASET_TTL_SECONDS` | Per-dataframe TTL for canvas-registered tables, in seconds. | `86400` (24 h) |
| `BLS_DATAFRAME_DROP_ENABLED` | Expose `bls_dataframe_drop`. TTL handles cleanup by default. | `false` |
| `CANVAS_PROVIDER_TYPE` | DataCanvas provider for tabular spillover of large result sets and the dataframe tools. Set to `none` to disable them. The Claude Desktop bundle ships without DuckDB and pins `none`. | `duckdb` |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_PORT` | HTTP server port. | `3010` |
| `MCP_SESSION_MODE` | Session mode. This server uses `stateless`; valid schema values are `auto`, `stateful`, and `stateless`. Schema-default `auto` resolves to `stateful`. | `stateless` |
| `MCP_AUTH_MODE` | Auth mode: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_LOG_LEVEL` | Log level (RFC 5424). | `info` |
| `LOGS_DIR` | Directory for log files (Node.js only). | `<project-root>/logs` |
| `OTEL_ENABLED` | Enable OpenTelemetry instrumentation. | `false` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Base OTLP URL for traces and metrics; signal-specific endpoints override it. | — |
| `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` | Opt-in OTLP log endpoint. The base URL never enables log export. | — |
| `LOG_TOOL_FAILURE_PAYLOADS` | Log failed-call arguments and results, redacted by key name; secrets in free-form values remain. | `false` |
| `LOG_TOOL_FAILURE_PAYLOAD_MAX_BYTES` | UTF-8 byte cap per logged failure payload. | `16384` |

See [`.env.example`](./.env.example) for the full list of optional overrides.

### Observation mirror (optional)

For high-volume workloads, an opt-in local mirror serves `bls_get_series` / `bls_get_latest` from an embedded SQLite store of the LABSTAT files instead of the BLS API, removing the 500/day quota cap; requests fall back to the live API until it is built. Enable it with `BLS_OBSERVATIONS_MIRROR_ENABLED=true`, then run the one-time bootstrap: `node dist/services/bls-observations/subprocess.js --init`. Settings, survey coverage, harvest checkpoint and exit codes, fallback and calculation behavior, and upgrade notes are in [docs/observation-mirror.md](./docs/observation-mirror.md).

## Running the server

### Local development

- **Build and run:**

  ```sh
  # One-time build
  bun run rebuild

  # Run the built server
  bun run start:stdio
  # or
  bun run start:http
  ```

- **Run checks and tests:**

  ```sh
  bun run devcheck   # Lint, format, typecheck, security
  bun run test       # Vitest test suite
  bun run lint:mcp   # Validate MCP definitions against spec
  ```

### Docker

```sh
docker build -t bls-labor-mcp-server .
docker run --rm -e BLS_API_KEY=your-key -e MCP_TRANSPORT_TYPE=http -p 3010:3010 bls-labor-mcp-server
```

The Dockerfile defaults to HTTP transport, stateless session mode, and logs to `/var/log/bls-labor-mcp-server`. OpenTelemetry peer dependencies are installed by default — build with `--build-arg OTEL_ENABLED=false` to omit them.

## Project structure

| Directory | Purpose |
|:----------|:--------|
| `src/index.ts` | `createApp()` entry point — registers tools and initializes services. |
| `src/config` | Server-specific environment variable parsing and validation with Zod. |
| `src/mcp-server/tools` | Tool definitions (`*.tool.ts`). |
| `src/services/bls-api` | BLS API v2 service — batch fetch, latest-value GET, surveys metadata. |
| `src/services/bls-catalog` | LABSTAT flat-file catalog — offline series index and search. |
| `src/services/bls-observations` | Optional LABSTAT observation mirror — embedded SQLite store, ingester, and refresh subprocess. |
| `src/services/bls-periods` | Period-code semantics shared by the API and mirror paths: annual-average codes (`M13`/`Q05`/`S03`) and the live API's period names. |
| `src/services/canvas-bridge` | DataCanvas bridge — dataframe registration, SQL gate, lifecycle management. |
| `docs/design.md` | Full tool surface specification, service architecture, and error contracts. |
| `docs/observation-mirror.md` | Observation mirror setup, coverage, and upgrade notes. |
| `tests/` | Unit and integration tests mirroring `src/`. |

## Development guide

See [`CLAUDE.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for request-scoped logging, `ctx.state` for tenant-scoped storage
- `bls_search_series` is the anchor tool — design workflows to call it before the API tools
- Wrap BLS API calls: validate raw → normalize to domain type → return output schema; never fabricate missing fields

## Contributing

Issues are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

Apache-2.0 — see [LICENSE](LICENSE) for details.
