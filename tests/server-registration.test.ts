/**
 * @fileoverview Entrypoint integration tests for environment defaults and published skills.
 * @module tests/server-registration.test
 */
import { execFile } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const root = process.cwd();
let fixture: string;
let entry: string;
let preload: string;

const CLIENT_SCRIPT = `
  import { Client } from '@modelcontextprotocol/client';
  import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
  const transport = new StdioClientTransport({
    command: process.env.TEST_RUNTIME,
    args: ['--import', process.env.TEST_PRELOAD, process.env.TEST_ENTRY],
    cwd: process.env.TEST_CWD,
    env: process.env,
    stderr: 'pipe',
  });
  const client = new Client({ name: 'server-registration-test', version: '1.0.0' });
  try {
    await client.connect(transport, { timeout: 10000 });
    const tools = await client.listTools();
    const resources = client.getServerCapabilities()?.resources ? await client.listResources() : { resources: [] };
    const skill = resources.resources.find((resource) => resource.uri.includes('bls-labor-guide/SKILL.md'));
    const contents = skill ? await client.readResource({ uri: skill.uri }) : undefined;
    process.stdout.write(JSON.stringify({
      names: tools.tools.map((tool) => tool.name),
      instructions: client.getInstructions(),
      skill: contents?.contents,
    }));
  } finally {
    await client.close();
  }
`;

interface RegisteredSurface {
  instructions: string;
  names: string[];
  skill?: { text?: string }[];
}

beforeAll(async () => {
  fixture = await mkdtemp(join(tmpdir(), 'bls-registration-'));
  entry = join(fixture, 'index.mjs');
  preload = join(fixture, 'offline.mjs');
  await writeFile(
    preload,
    "globalThis.fetch = async () => new Response('series_id\\tseries_title\\n', { status: 200 });\n",
  );
  await writeFile(join(fixture, 'package.json'), await readFile(join(root, 'package.json')));
  await symlink(join(root, 'node_modules'), join(fixture, 'node_modules'));
  await cp(join(root, 'skills'), join(fixture, 'skills'), { recursive: true });
  const compiler = join(root, 'node_modules/esbuild/bin/esbuild');
  const flags = ['--bundle', '--platform=node', '--format=esm', '--packages=external'];
  // Keep the dual-role child module separate so its main-entry guard stays real.
  await execFileAsync(
    'node',
    [
      compiler,
      'src/services/bls-observations/subprocess.ts',
      ...flags,
      `--outfile=${join(fixture, 'services/bls-observations/subprocess.js')}`,
    ],
    { cwd: root },
  );
  await execFileAsync(
    'node',
    [
      compiler,
      'src/index.ts',
      ...flags,
      '--external:./services/bls-observations/subprocess.js',
      `--outfile=${entry}`,
    ],
    { cwd: root },
  );
});

afterAll(async () => {
  await rm(fixture, { recursive: true });
});

/** Keep all launch state isolated; the preload prevents every external request. */
async function launchEnv(extra: Record<string, string> = {}, dotenv?: string) {
  const cwd = await mkdtemp(join(fixture, 'client-'));
  if (dotenv !== undefined) await writeFile(join(cwd, '.env'), dotenv);
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !key.startsWith('BLS_') &&
        !key.startsWith('CANVAS_') &&
        !key.startsWith('MCP_') &&
        key !== 'NODE_OPTIONS',
    ),
  );
  return {
    cwd,
    env: {
      ...env,
      BLS_CATALOG_DB_PATH: ':memory:',
      BLS_OBSERVATIONS_MIRROR_ENABLED: 'false',
      LOGS_DIR: join(cwd, 'logs'),
      MCP_TRANSPORT_TYPE: 'stdio',
      OTEL_ENABLED: 'false',
      ...extra,
    },
  };
}

async function readRegisteredSurface(
  runtime: string,
  extra: Record<string, string> = {},
  dotenv?: string,
): Promise<RegisteredSurface> {
  const launch = await launchEnv(extra, dotenv);
  const { stdout } = await execFileAsync('node', ['--input-type=module', '-e', CLIENT_SCRIPT], {
    cwd: root,
    env: {
      ...launch.env,
      TEST_RUNTIME: runtime,
      TEST_PRELOAD: preload,
      TEST_ENTRY: entry,
      TEST_CWD: launch.cwd,
    },
    timeout: 15000,
    maxBuffer: 1024 * 1024,
  });
  return JSON.parse(stdout) as RegisteredSurface;
}

describe.each(['node', 'bun'])('server registration on %s', (runtime) => {
  const coreTools = ['bls_list_surveys', 'bls_search_series', 'bls_get_latest', 'bls_get_series'];
  const canvasTools = [...coreTools, 'bls_dataframe_describe', 'bls_dataframe_query'];

  it('characterizes explicit canvas and drop registration', async () => {
    const surface = await readRegisteredSurface(runtime, {
      CANVAS_PROVIDER_TYPE: 'duckdb',
      BLS_DATAFRAME_DROP_ENABLED: 'true',
    });
    expect(surface.names).toEqual([...canvasTools, 'bls_dataframe_drop']);
  });

  it.each([undefined, '', '  ', `\${CANVAS_PROVIDER_TYPE}`])(
    'defaults an unconfigured provider (%s) to DuckDB',
    async (value) => {
      const surface = await readRegisteredSurface(
        runtime,
        value === undefined ? {} : { CANVAS_PROVIDER_TYPE: value },
      );
      expect(surface.names).toEqual(canvasTools);
      expect(surface.instructions).toContain('Large results spill');
    },
  );

  it.each(['false', 'true'])('honors exported none regardless of drop=%s', async (drop) => {
    const surface = await readRegisteredSurface(runtime, {
      CANVAS_PROVIDER_TYPE: 'none',
      BLS_DATAFRAME_DROP_ENABLED: drop,
    });
    expect(surface.names).toEqual(coreTools);
    expect(surface.instructions).toContain('full results return inline');
  });

  it('honors .env-only none from a neutral working directory', async () => {
    const surface = await readRegisteredSurface(runtime, {}, 'CANVAS_PROVIDER_TYPE=none\n');
    expect(surface.names).toEqual(coreTools);
  });

  it('preserves exported configuration over .env', async () => {
    const surface = await readRegisteredSurface(
      runtime,
      { CANVAS_PROVIDER_TYPE: 'none' },
      'CANVAS_PROVIDER_TYPE=duckdb\n',
    );
    expect(surface.names).toEqual(coreTools);
  });

  it('serves the actual guide when the client working directory has no skills', async () => {
    const surface = await readRegisteredSurface(runtime, { CANVAS_PROVIDER_TYPE: 'none' });
    expect(surface.skill?.[0]?.text).toContain('name: bls-labor-guide');
    expect(surface.skill?.[0]?.text).toContain('dataset.name');
  });

  it.each(['BLS_DATAFRAME_DROP_ENABLED', 'MCP_HTTP_PORT'])(
    'prints a clean startup banner for invalid %s',
    async (variable) => {
      const launch = await launchEnv({ [variable]: 'not-valid' });
      const result = await execFileAsync(runtime, ['--import', preload, entry], {
        ...launch,
        timeout: 10000,
      }).catch((error: { code: number; stderr: string }) => error);
      expect(result).toMatchObject({ code: 1 });
      expect(result.stderr).toContain('Configuration error — server failed to start');
      expect(result.stderr).toContain(variable);
      expect(result.stderr).not.toContain('Core services constructed');
      expect(result.stderr).not.toMatch(/\n\s+at /);
    },
  );
});
