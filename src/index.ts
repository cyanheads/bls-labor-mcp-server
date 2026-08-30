#!/usr/bin/env node
/**
 * @fileoverview bls-labor-mcp-server MCP server entry point. Registers all BLS tools
 * and initializes services via the framework's setup() callback.
 * @module index
 */

import { createApp, disabledTool } from '@cyanheads/mcp-ts-core';
import { config } from '@cyanheads/mcp-ts-core/config';
import { requestContextService, schedulerService, withExtra } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from './config/server-config.js';
import { blsDataframeDescribeTool } from './mcp-server/tools/definitions/bls-dataframe-describe.tool.js';
import { blsDataframeDropTool } from './mcp-server/tools/definitions/bls-dataframe-drop.tool.js';
import { blsDataframeQueryTool } from './mcp-server/tools/definitions/bls-dataframe-query.tool.js';
import { blsGetLatestTool } from './mcp-server/tools/definitions/bls-get-latest.tool.js';
import { blsGetSeriesTool } from './mcp-server/tools/definitions/bls-get-series.tool.js';
import { blsListSurveysTool } from './mcp-server/tools/definitions/bls-list-surveys.tool.js';
import { blsSearchSeriesTool } from './mcp-server/tools/definitions/bls-search-series.tool.js';
import { initBlsApiService } from './services/bls-api/bls-api-service.js';
import {
  getBlsCatalogService,
  initBlsCatalogService,
} from './services/bls-catalog/bls-catalog-service.js';
import { initBlsObservationsService } from './services/bls-observations/bls-observations-service.js';
import { runObservationsSubprocess } from './services/bls-observations/subprocess.js';
import { initCanvasBridge } from './services/canvas-bridge/canvas-bridge.js';

const cfg = getServerConfig();
const canvasEnabled = config.canvas.providerType === 'duckdb';

const canvasDisabled = {
  reason: 'DataCanvas is disabled in this deployment.',
  hint: 'CANVAS_PROVIDER_TYPE=duckdb',
};
const describeTool = canvasEnabled
  ? blsDataframeDescribeTool
  : disabledTool(blsDataframeDescribeTool, canvasDisabled);
const queryTool = canvasEnabled
  ? blsDataframeQueryTool
  : disabledTool(blsDataframeQueryTool, canvasDisabled);
const dropTool = !canvasEnabled
  ? disabledTool(blsDataframeDropTool, canvasDisabled)
  : cfg.dataframeDropEnabled
    ? blsDataframeDropTool
    : disabledTool(blsDataframeDropTool, {
        reason: 'bls_dataframe_drop is disabled by default — TTL handles lifecycle.',
        hint: 'BLS_DATAFRAME_DROP_ENABLED=true',
      });

const instructions =
  'Use the bls_* tools to fetch US labor, price, and employment statistics from the Bureau of Labor Statistics public API v2. A free BLS_API_KEY is optional (25 requests/day without, 500 with). Series use opaque positional SeriesIDs (e.g. LNS14000000); surveys use two-letter codes (CU, CE, LN). Workflow: bls_list_surveys, then bls_search_series (offline, no quota) to resolve concepts to SeriesIDs, then bls_get_series for history or bls_get_latest for current values. ' +
  (canvasEnabled
    ? 'Large results spill to a DataCanvas dataframe. Call bls_dataframe_describe with dataset.name to inspect column_schema, then use that table name in bls_dataframe_query SQL.'
    : 'DataCanvas is disabled. If a history request exceeds the inline budget, narrow start_year/end_year or enable CANVAS_PROVIDER_TYPE=duckdb and restart.');

await createApp({
  name: 'bls-labor-mcp-server',
  title: 'bls-labor-mcp-server',
  instructions,
  landing: { requireAuth: false },
  tools: [
    blsListSurveysTool,
    blsSearchSeriesTool,
    blsGetLatestTool,
    blsGetSeriesTool,
    describeTool,
    queryTool,
    dropTool,
  ],
  resources: [],
  prompts: [],

  async setup(core) {
    initBlsApiService(core.config, core.storage);
    initBlsCatalogService(core.config, core.storage);
    initBlsObservationsService(core.config, core.storage);
    initCanvasBridge(core.canvas);

    // Load catalog in background — non-blocking. bls_search_series throws
    // catalog_unavailable if called before loading completes.
    getBlsCatalogService()
      .load()
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[bls-labor-mcp-server] Catalog load error: ${msg}\n`);
      });

    // Schedule observation mirror refresh — HTTP transport only.
    // Stdio operators run syncs out-of-band (e.g. `node dist/services/bls-observations/subprocess.js`).
    const transport = core.config?.mcpTransportType ?? 'stdio';
    if (
      cfg.observationsMirrorEnabled &&
      cfg.observationsMirrorRefreshCron &&
      transport === 'http'
    ) {
      const bootCtx = requestContextService.createRequestContext({
        operation: 'bls-observations-refresh-init',
      });
      core.logger.info('Scheduling observations mirror refresh', bootCtx);

      await schedulerService.schedule(
        'bls-observations-refresh',
        cfg.observationsMirrorRefreshCron,
        async (jobCtx) => {
          const logContext = (meta?: Readonly<Record<string, unknown>>) =>
            meta ? withExtra(jobCtx, meta) : jobCtx;
          const mirrorLog = {
            debug: (m: string, meta?: Readonly<Record<string, unknown>>) =>
              core.logger.debug(m, logContext(meta)),
            info: (m: string, meta?: Readonly<Record<string, unknown>>) =>
              core.logger.info(m, logContext(meta)),
            notice: (m: string, meta?: Readonly<Record<string, unknown>>) =>
              core.logger.notice(m, logContext(meta)),
            warning: (m: string, meta?: Readonly<Record<string, unknown>>) =>
              core.logger.warning(m, logContext(meta)),
            error: (m: string, meta?: Readonly<Record<string, unknown>>) =>
              core.logger.error(m, logContext(meta)),
          };
          // Offload to a subprocess — synchronous SQLite writes must not block
          // the server's event loop. WAL allows concurrent readers throughout.
          await runObservationsSubprocess({ log: mirrorLog });
        },
        'Incremental LABSTAT observation harvest into the bls-observations SQLite mirror.',
      );
      schedulerService.start('bls-observations-refresh');
    }
  },
});
