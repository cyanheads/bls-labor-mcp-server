/**
 * @fileoverview Entrypoint integration tests for configuration-dependent tool registration.
 * @module tests/server-registration.test
 */

import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const tempDirectories: string[] = [];

const CLIENT_SCRIPT = `
  import { Client } from '@modelcontextprotocol/client';
  import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

  const transport = new StdioClientTransport({
    command: 'bun',
    args: ['run', 'src/index.ts'],
    cwd: process.cwd(),
    env: process.env,
    stderr: 'pipe',
  });
  const client = new Client({ name: 'server-registration-test', version: '1.0.0' });
  await client.connect(transport);
  const tools = await client.listTools();
  process.stdout.write(JSON.stringify({
    names: tools.tools.map((tool) => tool.name),
    instructions: client.getInstructions(),
  }));
  await client.close();
`;

interface RegisteredSurface {
  instructions: string;
  names: string[];
}

async function readRegisteredSurface(
  canvasProviderType: 'duckdb' | 'none',
  dataframeDropEnabled: boolean,
): Promise<RegisteredSurface> {
  const tempDirectory = await mkdtemp(join(tmpdir(), 'bls-registration-'));
  tempDirectories.push(tempDirectory);
  const { stdout } = await execFileAsync('node', ['--input-type=module', '-e', CLIENT_SCRIPT], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      BLS_CATALOG_DB_PATH: join(tempDirectory, 'catalog.db'),
      BLS_DATAFRAME_DROP_ENABLED: String(dataframeDropEnabled),
      CANVAS_PROVIDER_TYPE: canvasProviderType,
      LOGS_DIR: join(tempDirectory, 'logs'),
      MCP_TRANSPORT_TYPE: 'stdio',
    },
    maxBuffer: 1024 * 1024,
  });
  return JSON.parse(stdout) as RegisteredSurface;
}

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe('server registration', () => {
  const coreTools = ['bls_list_surveys', 'bls_search_series', 'bls_get_latest', 'bls_get_series'];

  it.each([false, true])(
    'advertises only core tools when canvas is disabled (drop=%s)',
    async (dropEnabled) => {
      const surface = await readRegisteredSurface('none', dropEnabled);

      expect(surface.names).toEqual(coreTools);
      expect(surface.instructions).toContain('DataCanvas is disabled');
      expect(surface.instructions).toContain('narrow start_year/end_year');
      expect(surface.instructions).not.toContain('bls_dataframe_describe');
      expect(surface.instructions).not.toContain('bls_dataframe_query');
    },
  );

  it('advertises describe and query when canvas is enabled but drop is disabled', async () => {
    const surface = await readRegisteredSurface('duckdb', false);

    expect(surface.names).toEqual([...coreTools, 'bls_dataframe_describe', 'bls_dataframe_query']);
    expect(surface.instructions.indexOf('bls_dataframe_describe')).toBeLessThan(
      surface.instructions.indexOf('bls_dataframe_query'),
    );
  });

  it('advertises all seven tools when canvas and drop are enabled', async () => {
    const surface = await readRegisteredSurface('duckdb', true);

    expect(surface.names).toEqual([
      ...coreTools,
      'bls_dataframe_describe',
      'bls_dataframe_query',
      'bls_dataframe_drop',
    ]);
    expect(surface.instructions.indexOf('bls_dataframe_describe')).toBeLessThan(
      surface.instructions.indexOf('bls_dataframe_query'),
    );
  });
});
