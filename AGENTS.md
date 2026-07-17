# Agent Protocol

**Server:** bls-labor-mcp-server
**Version:** 0.4.7
**Framework:** [@cyanheads/mcp-ts-core](https://www.npmjs.com/package/@cyanheads/mcp-ts-core) `^0.10.14`
**Engines:** Bun ≥1.3.0, Node ≥24.0.0
**Zod:** ^4.4.3

> **Read the framework docs first:** `node_modules/@cyanheads/mcp-ts-core/CLAUDE.md` contains the full API reference — builders, Context, error codes, exports, patterns. This file covers server-specific conventions only.

---

## What's Next?

When the user asks what to do next, what's left, or needs direction, suggest relevant options based on the current project state:

1. **Re-run the `setup` skill** — ensures CLAUDE.md, skills, structure, and metadata are populated and up to date with the current codebase
2. **Run the `design-mcp-server` skill** — if the tool/resource surface hasn't been mapped yet, work through domain design
3. **Add tools/resources/prompts** — scaffold new definitions using the `add-tool`, `add-app-tool`, `add-resource`, `add-prompt` skills
4. **Add services** — scaffold domain service integrations using the `add-service` skill
5. **Add tests** — scaffold tests for existing definitions using the `add-test` skill
6. **Field-test definitions** — exercise tools/resources/prompts with real inputs using the `field-test` skill, get a report of issues and pain points
7. **Run `devcheck`** — lint, format, typecheck, and security audit
8. **Run the `security-pass` skill** — audit handlers for MCP-specific security gaps: output injection, scope blast radius, input sinks, tenant isolation
9. **Run the `polish-docs-meta` skill** — finalize README, CHANGELOG, metadata, and agent protocol for shipping
10. **Run the `maintenance` skill** — investigate changelogs, adopt upstream changes, and sync skills after `bun update --latest`

Tailor suggestions to what's actually missing or stale — don't recite the full list every time.

---

## Domain: Bureau of Labor Statistics

`bls-labor-mcp-server` wraps the BLS public API v2, exposing US labor, price, productivity, and employment data. The BLS is the primary source for CPI, unemployment, wages, JOLTS, PPI, occupational employment, and related statistics.

**The central UX problem is SeriesID resolution.** BLS identifiers (`LNS14000000`, `CES0000000001`) encode survey + area + item + seasonal flag in opaque positional codes. Agents and users can't know them by heart. `bls_search_series` is the anchor tool — it resolves human concepts to SeriesIDs so the other tools can operate.

**API constraints to keep in mind:**
- 500 queries/day per `BLS_API_KEY`. `bls_get_series` (batch POST) counts as one query regardless of series count. `bls_get_latest` issues one GET per SeriesID — each counts as one query.
- 50 series per `bls_get_series` request; 20-year history window per request.
- `calculations: true` requests BLS-server-side net change and percent change; a survey returns whichever it supports (CPI/PPI return percent change only). Only surveys supporting neither return an error — check `bls_list_surveys`.

**Catalog search is offline.** `bls_search_series` operates against LABSTAT flat files bundled at build time — no API quota consumed. The BLS FAQ confirms there is no API catalog endpoint.

---

## Planned Tool Surface

| Tool | Purpose |
|:-----|:--------|
| `bls_list_surveys` | List BLS survey programs with codes, descriptions, and coverage. Use to orient before searching. |
| `bls_search_series` | Search for SeriesIDs by natural language, survey, area, or keywords. The entry point for most workflows. |
| `bls_get_series` | Fetch time-series data for 1–50 series by SeriesID, with optional year range and period-over-period calculations. |
| `bls_get_latest` | Return the single most recent observation for one or more series. Prefer for "current value" single-series asks. |

See `docs/design.md` for the full tool surface specification, service architecture, and error contracts.

---

## Core Rules

- **Logic throws, framework catches.** Tool/resource handlers are pure — throw on failure, no `try/catch`. Plain `Error` is fine; the framework catches, classifies, and formats. Use error factories (`notFound()`, `validationError()`, etc.) when the error code matters.
- **Use `ctx.log`** for request-scoped logging. No `console` calls.
- **Use `ctx.state`** for tenant-scoped storage. Never access persistence directly.
- **Check `ctx.elicit` / `ctx.sample`** for presence before calling.
- **Secrets in env vars only** — never hardcoded.
- **Close the loop on issues.** When implementing work tracked by a GitHub issue, comment on the issue with what landed before moving on. The comment is for future readers — state the concrete changes, not the conversation that produced them.

---

## Patterns

### Tool

```ts
import { tool, z } from '@cyanheads/mcp-ts-core';
import { getBlsCatalogService } from '@/services/bls-catalog/bls-catalog-service.js';

export const searchSeriesTool = tool('bls_search_series', {
  description: 'Search BLS series catalog by query, survey, area, or keywords to resolve cryptic SeriesIDs.',
  annotations: { readOnlyHint: true, openWorldHint: true },

  input: z.object({
    query: z.string().describe('Natural language or keyword query'),
    survey: z.string().optional().describe('Survey code (e.g., CPS, CES, CPI, PPI, JOLTS)'),
    area: z.string().optional().describe('State name, MSA, or FIPS area code'),
    seasonal_adjustment: z.boolean().optional().describe('Filter to seasonally adjusted series'),
    limit: z.number().int().min(1).max(50).default(10).describe('Max results to return'),
  }),

  output: z.object({
    series: z.array(z.object({
      seriesId: z.string().describe('BLS SeriesID'),
      title: z.string().describe('Plain-language series name'),
      survey: z.string().describe('Survey code'),
      area: z.string().optional().describe('Geographic area name'),
      item: z.string().optional().describe('Item/subject name'),
      seasonal: z.boolean().describe('Seasonally adjusted'),
    })).describe('Matching series'),
    total: z.number().describe('Total matches in catalog'),
  }),

  async handler(input, ctx) {
    ctx.log.info('Executing bls_search_series', { query: input.query });
    const result = await getBlsCatalogService().search(input);
    return result;
  },

  format: (result) => [{
    type: 'text',
    text: result.series.map(s =>
      `**${s.seriesId}** — ${s.title}${s.area ? ` · ${s.area}` : ''}${s.seasonal ? ' (SA)' : ''}`
    ).join('\n') + `\n\n_${result.total} total matches_`,
  }],
});
```

### Server config

```ts
// src/config/server-config.ts — lazy-parsed, separate from framework config
import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

const ServerConfigSchema = z.object({
  apiKey: z.string().describe('BLS v2 API key'),
  baseUrl: z.string().url().default('https://api.bls.gov/publicAPI/v2').describe('BLS API base URL'),
  catalogBaseUrl: z.string().url().default('https://download.bls.gov/pub/time.series').describe('LABSTAT flat-file base URL'),
  canvasProviderType: z.enum(['none', 'duckdb']).default('none').describe('DataCanvas provider for large result sets'),
});

let _config: z.infer<typeof ServerConfigSchema> | undefined;
export function getServerConfig() {
  _config ??= parseEnvConfig(ServerConfigSchema, {
    apiKey: 'BLS_API_KEY',
    baseUrl: 'BLS_BASE_URL',
    catalogBaseUrl: 'BLS_CATALOG_BASE_URL',
    canvasProviderType: 'CANVAS_PROVIDER_TYPE',
  });
  return _config;
}
```

`parseEnvConfig` maps Zod schema paths → env var names so errors name the variable (`BLS_API_KEY`) not the path (`apiKey`). Throws `ConfigurationError`, which the framework prints as a clean startup banner.

---

## Context

Handlers receive a unified `ctx` object. Key properties:

| Property | Description |
|:---------|:------------|
| `ctx.log` | Request-scoped logger — `.debug()`, `.info()`, `.notice()`, `.warning()`, `.error()`. Auto-correlates requestId, traceId, tenantId. |
| `ctx.state` | Tenant-scoped KV — `.get(key)`, `.set(key, value, { ttl? })`, `.delete(key)`, `.list(prefix, { cursor, limit })`. Accepts any serializable value. |
| `ctx.elicit` | Ask user for structured input. **Check for presence first:** `if (ctx.elicit) { ... }` |
| `ctx.sample` | Request LLM completion from the client. **Check for presence first:** `if (ctx.sample) { ... }` |
| `ctx.signal` | `AbortSignal` for cancellation. |
| `ctx.progress` | Task progress (present when `task: true`) — `.setTotal(n)`, `.increment()`, `.update(message)`. |
| `ctx.requestId` | Unique request ID. |
| `ctx.tenantId` | Tenant ID from JWT, `'default'` for stdio or HTTP+`MCP_AUTH_MODE=none`. |

---

## Errors

Handlers throw — the framework catches, classifies, and formats.

**Recommended: typed error contract.** Declare `errors: [{ reason, code, when, recovery, retryable? }]` on `tool()` / `resource()` to receive `ctx.fail(reason, …)` typed against the reason union. TypeScript catches typos at compile time, `data.reason` is auto-populated for observability, linter enforces conformance against the handler body. `recovery` is required descriptive metadata for the agent's next move (≥ 5 words, lint-validated); for the wire `data.recovery.hint` (mirrored into `content[]` text), pass explicitly at the throw site when dynamic context matters: `ctx.fail('reason', msg, { recovery: { hint: '...' } })`.

```ts
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';

errors: [
  { reason: 'quota_exceeded', code: JsonRpcErrorCode.ServiceUnavailable,
    when: 'BLS API 500 query/day limit hit',
    recovery: 'Retry after UTC midnight when the quota resets.' },
  { reason: 'series_not_found', code: JsonRpcErrorCode.InvalidParams,
    when: 'API returns "Series does not exist"',
    recovery: 'Use bls_search_series to find the correct SeriesID.' },
],
async handler(input, ctx) {
  // ...
  if (response.status === 'REQUEST_NOT_PROCESSED') throw ctx.fail('quota_exceeded', '...');
}
```

**Declare contracts inline on each tool.** The contract is part of the tool's public surface — one file should give the full picture. Don't extract a shared `errors[]` constant; per-tool repetition is the intended cost of locality.

**Fallback (no contract entry fits):** throw via factories or plain `Error`.

```ts
// Error factories — explicit code
import { notFound, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
throw notFound('Series not found', { seriesId });
throw serviceUnavailable('BLS API unavailable', { url }, { cause: err });

// Plain Error — framework auto-classifies from message patterns
throw new Error('Series does not exist');  // → NotFound
throw new Error('Invalid query format');   // → ValidationError
```

See `docs/design.md` for the full error contract table. Baseline codes (`InternalError`, `ServiceUnavailable`, `Timeout`, `ValidationError`, `SerializationError`) bubble freely and don't need declaring.

See framework CLAUDE.md and the `api-errors` skill for the full auto-classification table, all available factories, and the contract reference.

---

## Structure

```text
src/
  index.ts                              # createApp() entry point
  config/
    server-config.ts                    # BLS-specific env vars (Zod schema)
  services/
    bls-api/
      bls-api-service.ts                # BLS API v2 service (batch fetch, latest, surveys)
      types.ts                          # BLS API types
    bls-catalog/
      bls-catalog-service.ts            # LABSTAT flat-file catalog (offline search + on-disk cache)
      types.ts                          # Catalog domain types
    bls-observations/                   # Optional observation mirror (opt-in, default off)
      bls-observations-service.ts       # defineMirror wrapper — SQLite store + query
      ingester.ts                       # LABSTAT .data.* sync generator
      subprocess.ts                     # Event-loop-safe harvest subprocess (dual-role entry)
      types.ts                          # Observation row types
    canvas-bridge/
      canvas-bridge.ts                  # DataCanvas bridge (dataframe registration, SQL gate, lifecycle)
      sql-gate-extras.ts                # Bridge-layer SQL denial rules (system catalogs, DDL)
  mcp-server/
    tools/definitions/
      bls-list-surveys.tool.ts
      bls-search-series.tool.ts
      bls-get-series.tool.ts
      bls-get-latest.tool.ts
      bls-dataframe-describe.tool.ts
      bls-dataframe-query.tool.ts
      bls-dataframe-drop.tool.ts        # Opt-in via BLS_DATAFRAME_DROP_ENABLED=true
```

---

## Naming

| What | Convention | Example |
|:-----|:-----------|:--------|
| Files | kebab-case with suffix | `bls-get-series.tool.ts` |
| Tool/resource/prompt names | snake_case | `bls_get_series` |
| Directories | kebab-case | `src/services/bls-api/` |
| Descriptions | Single string or template literal, no `+` concatenation | `'Fetch time-series data by BLS SeriesID.'` |

---

## Skills

Skills are modular instructions in `skills/` at the project root. Read them directly when a task matches — e.g., `skills/add-tool/SKILL.md` when adding a tool.

Run `bun run list-skills` to get a quick index of available local skills with their paths.

**Agent skill directory:** Copy skills into the directory your agent discovers (Claude Code: `.claude/skills/`, others: equivalent). Skills then load as context without referencing `skills/` paths. After framework updates, run the `maintenance` skill — Phase B re-syncs the agent directory.

Available skills:

| Skill | Purpose |
|:------|:--------|
| `setup` | Post-init project orientation |
| `design-mcp-server` | Design tool surface, resources, and services for a new server |
| `add-tool` | Scaffold a new tool definition |
| `add-app-tool` | Scaffold an MCP App tool + paired UI resource |
| `add-resource` | Scaffold a new resource definition |
| `add-prompt` | Scaffold a new prompt definition |
| `add-service` | Scaffold a new service integration |
| `add-test` | Scaffold test file for a tool, resource, or service |
| `field-test` | Exercise tools/resources/prompts with real inputs, verify behavior, report issues |
| `tool-defs-analysis` | Read-only audit of MCP definition language across the surface — voice, leaks, defaults, recovery hints, output descriptions |
| `security-pass` | Audit server for MCP-flavored security gaps: output injection, scope blast radius, input sinks, tenant isolation |
| `code-simplifier` | Post-session cleanup against `git diff` — modernize syntax, consolidate duplication, align with the codebase |
| `devcheck` | Lint, format, typecheck, audit |
| `polish-docs-meta` | Finalize docs, README, metadata, and agent protocol for shipping |
| `maintenance` | Investigate changelogs, adopt upstream changes, sync skills to agent dirs |
| `orchestrations` | Chain task skills into a gated multi-phase pipeline — build-out, QA-fix, update-ship — when you can spawn sub-agents |
| `git-wrapup` | Land working-tree changes as a versioned commit + annotated tag — version bump, changelog, verify, tag. Local only. |
| `release-and-publish` | Push + npm + MCP Registry + GH Release + Docker. Picks up from `git-wrapup` |
| `report-issue-framework` | File a bug or feature request against `@cyanheads/mcp-ts-core` via `gh` CLI |
| `report-issue-local` | File a bug or feature request against this server's own repo via `gh` CLI |
| `api-auth` | Auth modes, scopes, JWT/OAuth |
| `api-canvas` | DataCanvas: register tabular data, run SQL, export, plus the `spillover()` helper for big result sets — Tier 3 opt-in |
| `api-mirror` | MirrorService: persistent, self-refreshing local mirror of bulk upstream datasets via embedded SQLite + FTS5 |
| `api-config` | AppConfig, parseConfig, env vars |
| `api-context` | Context interface, logger, state, progress |
| `api-errors` | McpError, JsonRpcErrorCode, error patterns |
| `api-linter` | Definition linter rule catalog — invoked by `bun run lint:mcp` and `devcheck` |
| `api-services` | LLM, Speech, Graph services |
| `api-testing` | createMockContext, test patterns |
| `api-utils` | Formatting, parsing, security, pagination, scheduling, telemetry helpers |
| `api-telemetry` | OTel catalog: spans, metrics, completion logs, env config, cardinality rules |
| `api-workers` | Cloudflare Workers runtime |

When you complete a skill's checklist, check the boxes and add a completion timestamp at the end (e.g., `Completed: 2026-05-21`).

---

## Commands

| Command | Purpose |
|:--------|:--------|
| `bun run build` | Compile TypeScript |
| `bun run rebuild` | Clean + build |
| `bun run clean` | Remove build artifacts |
| `bun run devcheck` | Lint + format + typecheck + security + changelog sync |
| `bun run audit:refresh` | Delete `bun.lock`, reinstall, re-audit. Use when `devcheck` flags a transitive advisory — stale lockfile can mask already-patched deps. If advisory survives, it's real. |
| `bun run tree` | Generate directory structure doc |
| `bun run format` | Auto-fix formatting |
| `bun run lint:mcp` | Validate MCP definitions against spec |
| `bun run lint:packaging` | Validate env var alignment between `manifest.json` and `server.json` stdio block |
| `bun run bundle` | Build and pack as `.mcpb` for one-click Claude Desktop install |
| `bun run list-skills` | Print available local skills with paths (for sub-agents) |
| `bun run test` | Run tests |
| `bun run start:stdio` | Production mode (stdio) |
| `bun run start:http` | Production mode (HTTP) |
| `bun run release:github` | Create GitHub Release from annotated tag (title + `.mcpb` attach) |
| `bun run changelog:build` | Regenerate `CHANGELOG.md` from `changelog/*.md` |
| `bun run changelog:check` | Verify `CHANGELOG.md` is in sync (used by devcheck) |

---

## Bundling

`bun run bundle` produces a `.mcpb` extension bundle for one-click install in Claude Desktop. MCPB is stdio-only — HTTP deployments are unaffected. `manifest.json` and `.mcpbignore` are the bundle control files; `lint:packaging` (run by `devcheck`) verifies env var names match between `manifest.json` and `server.json`.

**Adding an env var requires both files:** `server.json` (registry discovery, `environmentVariables[]`) and `manifest.json` (bundle install UX, `mcp_config.env` + `user_config`).

---

## Changelog

Directory-based, grouped by minor series via the `.x` semver-wildcard convention. Source of truth: `changelog/<major.minor>.x/<version>.md` (e.g. `changelog/0.1.x/0.1.0.md`) — one file per release. `CHANGELOG.md` is a navigation index regenerated by `bun run changelog:build` — never hand-edit it.

---

## Imports

```ts
// Framework — z is re-exported, no separate zod import needed
import { tool, z } from '@cyanheads/mcp-ts-core';
import { McpError, JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';

// Server's own code — via path alias
import { getBlsApiService } from '@/services/bls-api/bls-api-service.js';
import { getBlsCatalogService } from '@/services/bls-catalog/bls-catalog-service.js';
```

---

## Checklist

- [ ] Zod schemas: all fields have `.describe()`, only JSON-Schema-serializable types (no `z.custom()`, `z.date()`, `z.transform()`, `z.bigint()`, `z.symbol()`, `z.void()`, `z.map()`, `z.set()`, `z.function()`, `z.nan()`)
- [ ] Optional nested objects: handler guards for empty inner values from form-based clients (`if (input.obj?.field && ...)`, not just `if (input.obj)`). When regex/length constraints matter, use `z.union([z.literal(''), z.string().regex(...).describe(...)])` — literal variants are exempt from `describe-on-fields`.
- [ ] JSDoc `@fileoverview` + `@module` on every file
- [ ] `ctx.log` for logging, `ctx.state` for storage
- [ ] Handlers throw on failure — error factories or plain `Error`, no try/catch
- [ ] `format()` renders all data the LLM needs — different clients forward different surfaces (Claude Code → `structuredContent`, Claude Desktop → `content[]`); both must carry the same data. For `bls_get_series` and `bls_get_latest`, render all observation values, not just a count.
- [ ] BLS wrapping: raw/domain/output schemas reviewed against real upstream sparsity/nullability before finalizing required vs optional fields
- [ ] BLS wrapping: normalization and `format()` preserve uncertainty; do not fabricate facts from missing upstream data
- [ ] BLS wrapping: tests include at least one sparse payload case with omitted upstream fields
- [ ] Error contracts declared for quota_exceeded, series_not_found, series_locked, no_data_for_period, calculations_not_supported, catalog_unavailable (see design.md)
- [ ] `calculations: true` only requested for surveys where `allowsNetChange`/`allowsPercentChange` is confirmed — guard or document
- [ ] `bls_get_latest` issues N sequential GETs (one per SeriesID) — keep recommended limit ≤10 in docs
- [ ] Registered in `createApp()` arrays (directly or via barrel exports)
- [ ] Tests use `createMockContext()` from `@cyanheads/mcp-ts-core/testing`
- [ ] `.codex-plugin/plugin.json` populated — `name`, `version`, `description`, `repository`, `license` from `package.json`; `interface.displayName` = package name; `interface.shortDescription` from `package.json` description
- [ ] `.codex-plugin/mcp.json` updated — server name key matches `package.json` name; env vars added for any required API keys
- [ ] `.claude-plugin/plugin.json` populated — `name`, `version`, `description`, `repository`, `license` from `package.json`; inline `mcpServers` entry with server name key, env vars for any required API keys
- [ ] `bun run devcheck` passes
