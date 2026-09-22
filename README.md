<div align="center">
  <h1>@cyanheads/bls-labor-mcp-server</h1>
  <p><b>Fetch US Bureau of Labor Statistics data — CPI, unemployment, wages, JOLTS, and more via MCP. STDIO or Streamable HTTP.</b>
  <div>4 Tools by default · 6 with DataCanvas · 7 with opt-in drop</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.5.3-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/bls-labor-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.0.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/bls-labor-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/bls-labor-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.0-blueviolet.svg?style=flat-square)](https://bun.sh/)

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

US labor statistics from the Bureau of Labor Statistics public API v2 and LABSTAT flat-file catalog. Resolve opaque SeriesIDs from natural language, fetch historical time-series or the latest observation, and query large multi-series results with SQL through an optional DataCanvas. Runs as a stdio process, a local Streamable HTTP server, or the public hosted endpoint above.

### Tools

| Tool | Description |
|:-----|:------------|
| `bls_list_surveys` | List BLS survey programs (CPI, CPS, CES, JOLTS, PPI, OEWS, …) with codes, descriptions, and calculation-support flags. |
| `bls_search_series` | Search the BLS series catalog by natural language, survey, area, or keywords to resolve cryptic SeriesIDs. |
| `bls_get_series` | Fetch time-series data for 1–50 BLS series by SeriesID, with optional year range and period-over-period calculations. |
| `bls_get_latest` | Return the single most recent observation for one or more BLS series. |
| `bls_dataframe_describe` | List canvas dataframes registered by `bls_get_series` — provenance, TTL, row count, column schema. Available when `CANVAS_PROVIDER_TYPE=duckdb`. |
| `bls_dataframe_query` | Run a SELECT against canvas dataframes registered by `bls_get_series`. Supports JOINs, aggregates, window functions, CTEs. Available when `CANVAS_PROVIDER_TYPE=duckdb`. |
| `bls_dataframe_drop` | Drop a canvas dataframe by name. Available when `CANVAS_PROVIDER_TYPE=duckdb` and `BLS_DATAFRAME_DROP_ENABLED=true`; TTL handles cleanup by default. |

## Capability reference

### `bls_list_surveys` <sub>tool</sub>

- Optional `category` filter narrows results to `prices`, `employment`, `wages`, `productivity`, `injuries`, or `time_use`
- Returns survey abbreviation, full name, and calculation-support flags (`allowsNetChange`, `allowsPercentChange`, `hasAnnualAverages`)
- `hasAnnualAverages` is advisory only — LN, CE, LA, and SM report true yet publish no annual-average rows; read `bls_get_series`'s `annualAverageRows` to see what a call actually returns
- Backed by the live BLS `/surveys` API with monthly caching — consumes no meaningful API quota

---

### `bls_search_series` <sub>tool</sub>

- Free-text or keyword query, plus optional `survey` (two-letter code), `area` (state/MSA/FIPS), and `seasonal_adjustment` filters; `limit` 1–50 (default 10)
- Decodes BLS's opaque positional SeriesIDs (e.g. `LNS14000000`) into survey, area, item, and seasonal-flag components alongside the plain-language title
- Also accepts a SeriesID directly for exact lookup
- `capped: true` means the ~1000-candidate FTS pool was exhausted — `totalCount` is then a lower bound, not an exact match count
- Operates entirely offline against the LABSTAT catalog index — consumes no BLS API quota

---

### `bls_get_series` <sub>tool</sub>

- Batch fetch 1–50 SeriesIDs per call; the whole batch counts as one of the 500 daily API queries
- Optional `start_year`/`end_year` window (BLS caps requests at 20 years) and `calculations: true` for BLS server-side net/percent change — a survey returns whichever it supports and omits the rest (CPI/PPI return percent change only)
- BLS needs both year bounds or neither: `start_year` alone resolves `end_year` to the current year, capped at `start_year + 19`; `end_year` alone is rejected without spending a query. `enrichment.startYearApplied`/`endYearApplied` report the window actually applied
- Optional `annual_average: true` adds each year's mean as an extra `M13`/`Q05`/`S03` row; `enrichment.annualAverageRows` reports how many were added
- BLS's raw `-` missing-value sentinel is preserved in `value` but reflected in `available` and excluded from `availableObservationCount`
- A mixed batch keeps valid series when another SeriesID is invalid or empty — the unresolved ID stays listed with zero observations and reason-specific guidance
- With `CANVAS_PROVIDER_TYPE=duckdb`, observation counts over the inline budget spill to a DataCanvas dataframe (`dataset.name`) for `bls_dataframe_describe`/`bls_dataframe_query`; without it configured, an oversized request fails with `canvas_unavailable` — narrow `start_year`/`end_year` instead

---

### `bls_get_latest` <sub>tool</sub>

- One GET per SeriesID (no batch-latest endpoint in BLS v2); each call counts as one of the 500 daily API queries — recommended ≤10 series, maximum 50
- For "current value" across many series, `bls_get_series` with a narrow year window is more quota-efficient (one query regardless of series count)
- Partial success — failed series appear in a separate `failed[]` array (`seriesId` + `error`) instead of failing the whole call
- `latestObservation.available` is false when BLS published the `-` missing-value sentinel for that period

---

### `bls_dataframe_describe` <sub>tool</sub>

- Available only when `CANVAS_PROVIDER_TYPE=duckdb`
- Optional `name` describes a single dataframe; omit to list every active dataframe for the tenant
- Each entry carries source tool, query params, row count, TTL (`created_at`/`expires_at`), and `column_schema` — all BLS dataframe columns are nullable
- Lazy-sweeps expired entries before responding

---

### `bls_dataframe_query` <sub>tool</sub>

- Available only when `CANVAS_PROVIDER_TYPE=duckdb`
- Single-statement SELECT only — writes, DDL, DROP, COPY, PRAGMA, ATTACH, and external-file table functions are rejected; system catalogs (`information_schema`, `pg_catalog`, `sqlite_master`, `duckdb_*`) are denied
- Supports JOINs, aggregates, window functions, and CTEs against `df_<id>` tables registered by `bls_get_series`
- `row_limit` caps materialized rows (default 1000, max 10000); optional `register_as` persists the result as a new dataframe with a fresh TTL for chained analysis without re-querying BLS
- Zero BLS API quota consumed

---

### `bls_dataframe_drop` <sub>tool</sub>

- Input: single required `name` (`df_XXXXX_XXXXX`) — the canvas table to drop
- Available only when `CANVAS_PROVIDER_TYPE=duckdb` and explicitly enabled via `BLS_DATAFRAME_DROP_ENABLED=true` — off by default since per-table TTL handles cleanup
- Idempotent — returns `dropped: false` when the named dataframe doesn't exist

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

BLS-specific:

- BLS API v2 client with retry/backoff and daily quota tracking
- Offline series catalog search against LABSTAT flat files, indexed as an on-disk SQLite/FTS5 store — zero API quota for discovery; the OES/OEWS wage survey (~6M series) is opt-in via `BLS_CATALOG_INCLUDE_OES`
- Typed error contracts for BLS-specific failure modes — quota exhaustion, locked database, calculations not supported
- Period-over-period net/percent-change calculations via BLS's own server-side flag, consistent with BLS's published numbers
- Optional DataCanvas spillover (DuckDB) for large multi-series result sets — schema discovery and SQL access without re-querying the API

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
| `BLS_CATALOG_CACHE_TTL_HOURS` | Catalog freshness window in hours — re-harvest once the index is older. | `168` (7 days) |
| `BLS_CATALOG_INCLUDE_OES` | Include the OES/OEWS wage survey (~6M series / ~1.2 GB; multi-minute first harvest). Off by default — OES series stay fetchable by ID. | `false` |
| `BLS_OBSERVATIONS_MIRROR_ENABLED` | Serve observations from a local SQLite mirror instead of the live API (requires a one-time bootstrap — see below). | `false` |
| `BLS_DATASET_TTL_SECONDS` | Per-dataframe TTL for canvas-registered tables, in seconds. | `86400` (24 h) |
| `BLS_DATAFRAME_DROP_ENABLED` | Expose `bls_dataframe_drop`. TTL handles cleanup by default. | `false` |
| `CANVAS_PROVIDER_TYPE` | Set to `duckdb` to enable DataCanvas tabular spillover for large result sets. | `none` |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_PORT` | HTTP server port. | `3010` |
| `MCP_SESSION_MODE` | Session mode. This server uses `stateless`; valid schema values are `auto`, `stateful`, and `stateless`. Schema-default `auto` resolves to `stateful`. | `stateless` |
| `MCP_AUTH_MODE` | Auth mode: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_LOG_LEVEL` | Log level (RFC 5424). | `info` |
| `LOGS_DIR` | Directory for log files (Node.js only). | `<project-root>/logs` |
| `OTEL_ENABLED` | Enable OpenTelemetry instrumentation. | `false` |

See [`.env.example`](./.env.example) for the full list of optional overrides.

### Observation mirror (optional)

For high-volume workloads, an opt-in local mirror serves `bls_get_series` / `bls_get_latest` from an embedded SQLite store instead of the BLS API — eliminating the 500/day quota cap. It is off by default. To enable:

1. Set `BLS_OBSERVATIONS_MIRROR_ENABLED=true` (and review the `BLS_OBSERVATIONS_MIRROR_*` vars in [`.env.example`](./.env.example)).
2. Run the one-time bootstrap out-of-band — it downloads the full LABSTAT observation set and can take a while:

   ```sh
   node dist/services/bls-observations/subprocess.js --init
   ```

Until the bootstrap completes, requests fall back to the live API (unless `BLS_OBSERVATIONS_MIRROR_FALLBACK_LIVE=false`). On HTTP transport, an incremental refresh runs on the `BLS_OBSERVATIONS_MIRROR_REFRESH_CRON` schedule. In containers, mount a persistent volume at `BLS_OBSERVATIONS_MIRROR_PATH`.

**Upgrading an existing mirror.** A mirror bootstrapped before sentinel rows were stored is missing the periods BLS publishes with its `-` missing-value marker. Opening such a mirror clears its sync checkpoint once, so the next refresh re-reads every LABSTAT file and fills them in — no operator action beyond letting that refresh run, and it takes as long as a full read. The mirror keeps serving throughout.

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
| `src/services/bls-periods` | Annual-average period semantics (`M13`/`Q05`/`S03`) shared by the API and mirror paths. |
| `src/services/canvas-bridge` | DataCanvas bridge — dataframe registration, SQL gate, lifecycle management. |
| `docs/design.md` | Full tool surface specification, service architecture, and error contracts. |
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
