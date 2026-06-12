/**
 * @fileoverview BLS-specific server configuration. Parsed lazily from
 * environment variables via `parseEnvConfig` so Worker env injection lands
 * before the first property read.
 * @module config/server-config
 */

import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

const ServerConfigSchema = z.object({
  apiKey: z
    .string()
    .default('')
    .describe(
      'BLS v2 API key — optional (25 req/day without, 500/day with). Register free at bls.gov/developers',
    ),
  baseUrl: z
    .string()
    .url()
    .default('https://api.bls.gov/publicAPI/v2')
    .describe('BLS API v2 base URL'),
  catalogBaseUrl: z
    .string()
    .url()
    .default('https://download.bls.gov/pub/time.series')
    .describe('LABSTAT flat-file base URL — override to point at a local mirror'),
  catalogDbPath: z
    .string()
    .default('.cache/bls-catalog.db')
    .describe(
      'Filesystem path for the on-disk SQLite catalog index. Persists across restarts and is queried on demand — the index is not held in memory. Empty uses an in-memory database (re-harvested every boot). In containers, mount a volume here to survive image updates.',
    ),
  catalogCacheTtlHours: z.coerce
    .number()
    .int()
    .positive()
    .default(168)
    .describe(
      'Catalog freshness window in hours — re-harvest into the SQLite index once its last completion is older (default 168 h / 7 days; the LABSTAT catalog changes slowly). The existing index stays queryable throughout a refresh.',
    ),
  catalogIncludeOes: z
    .stringbool()
    .default(false)
    .describe(
      'Include the OES/OEWS occupational-wage survey in the catalog index. Off by default — OES alone is ~6M series / ~1.2 GB (32× the rest of the catalog combined), adding a multi-minute first harvest and GBs of on-disk index. OES series stay fetchable by ID via bls_get_series when off.',
    ),
  userAgent: z
    .string()
    .default('cyanheads-bls-mcp/1.0 (casey@caseyjhand.com)')
    .describe(
      'User-Agent sent on all HTTP requests. BLS data-access policy requires a descriptive UA with a contact; download.bls.gov (Akamai) rejects any UA containing a URL, so use a name + contact email only — no https:// link.',
    ),
  datasetTtlSeconds: z.coerce
    .number()
    .int()
    .positive()
    .default(86400)
    .describe('Per-table TTL for canvas-registered dataframes, in seconds (default 24 h)'),
  dataframeDropEnabled: z
    .stringbool()
    .default(false)
    .describe('Expose bls_dataframe_drop when true — off by default; TTL handles cleanup'),

  // ── Observations mirror ───────────────────────────────────────────────
  observationsMirrorEnabled: z
    .stringbool()
    .default(false)
    .describe(
      'Enable the local LABSTAT observation mirror. Off by default — requires a one-time bootstrap (bls-observations-init) before serving mirror traffic.',
    ),
  observationsMirrorPath: z
    .string()
    .default('.mirror/bls-observations.db')
    .describe(
      'Filesystem path for the observations SQLite store. In containers, mount a persistent volume here so the mirror survives image updates.',
    ),
  observationsMirrorRefreshCron: z
    .string()
    .default('0 6 * * 1')
    .describe(
      'Cron expression for incremental observation refreshes (HTTP transport only). Default: Monday 06:00 UTC. Stdio operators run refreshes out-of-band.',
    ),
  observationsMirrorFallbackLive: z
    .stringbool()
    .default(true)
    .describe(
      'Fall back to the live BLS API when the mirror is not ready or a series has no mirror rows. When false, a not-ready mirror returns an error.',
    ),
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;

let _config: ServerConfig | undefined;

export function getServerConfig(): ServerConfig {
  _config ??= parseEnvConfig(ServerConfigSchema, {
    apiKey: 'BLS_API_KEY',
    baseUrl: 'BLS_BASE_URL',
    catalogBaseUrl: 'BLS_CATALOG_BASE_URL',
    catalogDbPath: 'BLS_CATALOG_DB_PATH',
    catalogCacheTtlHours: 'BLS_CATALOG_CACHE_TTL_HOURS',
    catalogIncludeOes: 'BLS_CATALOG_INCLUDE_OES',
    datasetTtlSeconds: 'BLS_DATASET_TTL_SECONDS',
    dataframeDropEnabled: 'BLS_DATAFRAME_DROP_ENABLED',
    userAgent: 'BLS_USER_AGENT',
    observationsMirrorEnabled: 'BLS_OBSERVATIONS_MIRROR_ENABLED',
    observationsMirrorPath: 'BLS_OBSERVATIONS_MIRROR_PATH',
    observationsMirrorRefreshCron: 'BLS_OBSERVATIONS_MIRROR_REFRESH_CRON',
    observationsMirrorFallbackLive: 'BLS_OBSERVATIONS_MIRROR_FALLBACK_LIVE',
  });
  return _config;
}

/** Reset the cached config (test helper). */
export function resetServerConfig(): void {
  _config = undefined;
}
