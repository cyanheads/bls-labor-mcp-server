/**
 * @fileoverview A real framework DataCanvas on the DuckDB provider, for tests
 * whose subject is what DuckDB does with a table — its column types, its drop —
 * rather than what a fake says it does. Scratch and export paths live under the
 * OS temp dir; the in-process sweeper is off so a test controls every expiry.
 * @module tests/fixtures/duckdb-canvas
 */

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CanvasRegistry, DataCanvas, DuckdbProvider } from '@cyanheads/mcp-ts-core/canvas';

/** Create a DuckDB-backed DataCanvas. Pair with `canvas.shutdown(ctx)` in teardown. */
export function createDuckdbCanvas(): DataCanvas {
  const scratch = join(tmpdir(), 'bls-labor-mcp-server-tests');
  const provider = new DuckdbProvider({
    memoryLimitMb: 256,
    exportRootPath: join(scratch, 'export'),
    tempRootPath: join(scratch, 'tmp'),
    defaultRowLimit: 10_000,
    schemaSniffRows: 100,
  });
  const registry = new CanvasRegistry(provider, {
    ttlMs: 86_400_000,
    absoluteCapMs: 7 * 86_400_000,
    maxCanvasesPerTenant: 100,
    sweeperIntervalMs: 0,
  });
  return new DataCanvas(provider, registry);
}
