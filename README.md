<div align="center">
  <h1>@cyanheads/bls-labor-mcp-server</h1>
  <p><b>Fetch US Bureau of Labor Statistics data — CPI, unemployment, wages, JOLTS, and more via MCP. STDIO or Streamable HTTP.</b>
  <div>7 Tools</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.4.11-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/bls-labor-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^1.29.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/bls-labor-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/bls-labor-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^6.0.3-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.3.14-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/bls-labor-mcp-server/releases/latest/download/bls-labor-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=bls-labor-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvYmxzLWxhYm9yLW1jcC1zZXJ2ZXIiXSwiZW52Ijp7IkJMU19BUElfS0VZIjoieW91ci1hcGkta2V5In19) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22bls-labor-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Fbls-labor-mcp-server%22%5D%2C%22env%22%3A%7B%22BLS_API_KEY%22%3A%22your-api-key%22%7D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

<div align="center">

**Public Hosted Server:** [https://bls-labor.caseyjhand.com/mcp](https://bls-labor.caseyjhand.com/mcp)

</div>

---

## Tools

Seven tools in two groups — four for BLS data access (survey discovery, SeriesID resolution, history, current values) and three for optional DataCanvas SQL analysis of large result sets:

| Tool | Description |
|:-----|:------------|
| `bls_list_surveys` | List BLS survey programs (CPI, CPS, CES, JOLTS, PPI, OEWS, …) with codes, descriptions, and calculation-support flags. |
| `bls_search_series` | Search the BLS series catalog by natural language, survey, area, or keywords to resolve cryptic SeriesIDs. |
| `bls_get_series` | Fetch time-series data for 1–50 BLS series by SeriesID, with optional year range and period-over-period calculations. |
| `bls_get_latest` | Return the single most recent observation for one or more BLS series. |
| `bls_dataframe_describe` | List canvas dataframes registered by `bls_get_series` — provenance, TTL, row count, column schema. Requires `CANVAS_PROVIDER_TYPE=duckdb`. |
| `bls_dataframe_query` | Run a SELECT against canvas dataframes registered by `bls_get_series`. Supports JOINs, aggregates, window functions, CTEs. Requires `CANVAS_PROVIDER_TYPE=duckdb`. |
| `bls_dataframe_drop` | Drop a canvas dataframe by name. Opt-in via `BLS_DATAFRAME_DROP_ENABLED=true`; TTL handles cleanup by default. Requires `CANVAS_PROVIDER_TYPE=duckdb`. |

### `bls_list_surveys`

List available BLS survey programs and their metadata.

- Covers all major BLS programs: CPS, CES, CPI, PPI, JOLTS, LAUS, OEWS, ECEC, and others
- Optional `category` filter (`prices`, `employment`, `wages`, `productivity`, `injuries`, `time_use`)
- Returns survey codes, descriptions, and calculation-support flags (`allowsNetChange`, `allowsPercentChange`, `hasAnnualAverages`)
- Backed by the live BLS surveys API with monthly caching; does not consume daily API quota

---

### `bls_search_series`

The entry point for most BLS workflows. Resolves human concepts to BLS SeriesIDs.

- BLS identifiers like `LNS14000000` and `CES0000000001` encode survey + area + item + seasonal flag in opaque positional codes — this tool decodes them
- Free-text and keyword search against the full BLS series catalog
- Filter by survey code, geographic area (state name, MSA, or FIPS), and seasonal adjustment flag
- Returns decoded series components (survey, area, item, seasonal flag) alongside the plain-language name
- Operates entirely offline against LABSTAT flat files bundled at startup — no API quota consumed
- Use before `bls_get_series` or `bls_get_latest` when you have a concept but not a SeriesID

---

### `bls_get_series`

Fetch historical time-series data for one or more BLS series.

- Batch fetch up to 50 series per request (counts as one of the 500 daily API queries)
- Optional `start_year` / `end_year` window (BLS caps history at 20 years per request)
- Optional `calculations: true` for BLS-server-side net change and percent change — a survey returns whichever it supports (CPI/PPI return percent change only); check `bls_list_surveys` for per-survey support
- Optional `annual_average: true` adds each year's annual-average row (period `M13`, `Q05` or `S03`) — the mean of that year's real periods, not an additional one. Off by default, so observations are safe to sum or average as returned; `enrichment.annualAverageRows` reports how many were added
- Returns observations with series metadata (title, area, item, seasonality)
- Spills to a DataCanvas dataframe when the observation count exceeds the inline context budget — response includes a `dataset.name` handle for SQL via `bls_dataframe_query`. Requires `CANVAS_PROVIDER_TYPE=duckdb`.

---

### `bls_get_latest`

Get the current value for one or more BLS series.

- Issues one GET per SeriesID (no batch-latest endpoint exists in BLS v2) — each counts as one of the 500 daily API queries
- Recommended limit: ≤10 series per call; accepts up to 50
- For "current value" across many series, `bls_get_series` with a narrow year window is more quota-efficient (one API query regardless of series count)
- Partial success reporting — failed series are returned in a separate `failed[]` array alongside successful results

---

### `bls_dataframe_describe`

Inspect canvas dataframes registered by `bls_get_series`.

- Lists all active dataframes for the current tenant: table name, source tool, query params, row count, column schema, TTL
- Optionally describe a single dataframe by name
- Lazy-sweeps expired entries before responding
- Use before writing SQL to confirm column names

---

### `bls_dataframe_query`

Run SQL against canvas dataframes registered by `bls_get_series`.

- Read-only: writes, DDL, DROP, COPY, PRAGMA, ATTACH, and external-file table functions are rejected
- Supports JOINs, aggregates, window functions, and CTEs
- Optional `register_as` persists the query result as a new named dataframe with a fresh TTL — useful for chaining analyses without re-consuming BLS API quota
- Inline row cap: 1,000 rows by default (max 10,000); full results live on-canvas when `register_as` is set
- Zero BLS API quota consumed

---

### `bls_dataframe_drop`

Drop a canvas dataframe by name. Idempotent — returns `dropped: false` when nothing matched.

- Use to free canvas resources ahead of the per-table TTL when an analysis is complete
- Must be explicitly enabled via `BLS_DATAFRAME_DROP_ENABLED=true` (TTL handles cleanup by default)

## Features

Built on [`@cyanheads/mcp-ts-core`](https://www.npmjs.com/package/@cyanheads/mcp-ts-core):

- Declarative tool definitions — single file per tool, framework handles registration and validation
- Unified error handling across all tools
- Pluggable auth (`none`, `jwt`, `oauth`)
- Swappable storage backends: `in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`
- Structured logging with optional OpenTelemetry tracing
- STDIO and Streamable HTTP transports

BLS-specific:

- BLS API v2 integration with retry/backoff and daily quota tracking
- Offline series catalog search against LABSTAT flat files — zero API quota for discovery
- Typed error contracts for BLS-specific failure modes: quota exhaustion, locked database, calculations not supported
- Period-over-period calculations via BLS server-side flag (consistent with BLS published numbers)
- DataCanvas spillover (DuckDB) for large multi-series result sets — SQL access without re-querying the API
- Optional local observation mirror — sync LABSTAT bulk data into an embedded SQLite store to serve `bls_get_series` / `bls_get_latest` without the 500/day API cap (opt-in, off by default)
- On-disk SQLite catalog index — the series catalog is parsed into an FTS5 SQLite store, queried on demand (not held in memory) and persisted across restarts; the OES/OEWS wage survey (~6M series) is opt-in via `BLS_CATALOG_INCLUDE_OES`

## Getting started

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
MCP_TRANSPORT_TYPE=http MCP_HTTP_PORT=3010 BLS_API_KEY=... bun run start:http
# Server listens at http://localhost:3010/mcp
```

### Prerequisites

- [Bun v1.3.2](https://bun.sh/) or higher (or Node.js v24+).
- A free BLS API v2 key — register at [bls.gov/developers](https://www.bls.gov/developers/home.htm). Grants 500 queries/day; the server also works without a key at 25 req/day.

### Installation

1. **Clone the repository:**

```sh
git clone https://github.com/cyanheads/bls-labor-mcp-server.git
```

2. **Navigate into the directory:**

```sh
cd bls-mcp-server
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

Issues and pull requests are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

Apache-2.0 — see [LICENSE](LICENSE) for details.
