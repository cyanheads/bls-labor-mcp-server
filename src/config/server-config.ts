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
  userAgent: z
    .string()
    .default(
      'cyanheads-bls-mcp/1.0 (https://github.com/cyanheads/bls-labor-mcp-server; casey@caseyjhand.com)',
    )
    .describe(
      'User-Agent sent on all HTTP requests — BLS data-access policy requires a descriptive UA with contact',
    ),
  datasetTtlSeconds: z.coerce
    .number()
    .int()
    .positive()
    .default(86400)
    .describe('Per-table TTL for canvas-registered dataframes, in seconds (default 24 h)'),
  dataframeDropEnabled: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true')
    .describe('Expose bls_dataframe_drop when true — off by default; TTL handles cleanup'),
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;

let _config: ServerConfig | undefined;

export function getServerConfig(): ServerConfig {
  _config ??= parseEnvConfig(ServerConfigSchema, {
    apiKey: 'BLS_API_KEY',
    baseUrl: 'BLS_BASE_URL',
    catalogBaseUrl: 'BLS_CATALOG_BASE_URL',
    datasetTtlSeconds: 'BLS_DATASET_TTL_SECONDS',
    dataframeDropEnabled: 'BLS_DATAFRAME_DROP_ENABLED',
    userAgent: 'BLS_USER_AGENT',
  });
  return _config;
}

/** Reset the cached config (test helper). */
export function resetServerConfig(): void {
  _config = undefined;
}
