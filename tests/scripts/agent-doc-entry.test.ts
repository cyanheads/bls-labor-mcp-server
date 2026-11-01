/**
 * @fileoverview Keep bundle cleanup from deleting the MCP SDK's skill runtime.
 * @module tests/scripts/agent-doc-entry.test
 */
import { describe, expect, it } from 'vitest';
import { AGENT_DOC_ENTRY as cleanerPattern } from '../../scripts/clean-mcpb.js';
import { AGENT_DOC_ENTRY as packagingPattern } from '../../scripts/lint-packaging.js';

describe.each([
  ['cleaner', cleanerPattern],
  ['packaging', packagingPattern],
] as const)('%s package agent-doc selection', (_name, pattern) => {
  it('removes package-root development docs, including nested dependencies', () => {
    for (const entry of [
      'node_modules/@cyanheads/mcp-ts-core/framework-skills/add-tool/SKILL.md',
      'node_modules/example/skills/search/SKILL.md',
      'node_modules/example/.claude/skills/helper/SKILL.md',
      'node_modules/example/SKILL.md',
      'node_modules/example/node_modules/@scope/nested/.agents/skills/helper/SKILL.md',
    ])
      expect(pattern.test(entry), entry).toBe(true);
  });

  it('preserves SDK executable skill modules and the server published skills', () => {
    for (const entry of [
      'node_modules/@modelcontextprotocol/server/dist/ext/skills/index.js',
      'node_modules/@modelcontextprotocol/server/dist/ext/skills/loader.js',
      'node_modules/example/dist/skills/processor.js',
      'skills/bls-analysis/SKILL.md',
    ])
      expect(pattern.test(entry), entry).toBe(false);
  });
});
