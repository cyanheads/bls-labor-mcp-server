# bls-labor-mcp-server - Directory Structure

Generated on: 2026-06-05 02:43:22

```text
bls-labor-mcp-server/
├── .claude/
├── .claude-plugin/
│   └── plugin.json
├── .codex-plugin/
│   ├── mcp.json
│   └── plugin.json
├── .github/
│   └── ISSUE_TEMPLATE/
│       ├── bug_report.yml
│       ├── config.yml
│       └── feature_request.yml
├── .vscode/
│   ├── extensions.json
│   └── settings.json
├── changelog/
│   ├── 0.1.x/
│   ├── 0.2.x/
│   ├── 0.3.x/
│   ├── 0.4.x/
│   └── template.md
├── docs/
│   ├── design.md
│   └── idea.md
├── scripts/
│   ├── build-changelog.ts
│   ├── build.ts
│   ├── check-docs-sync.ts
│   ├── check-framework-antipatterns.ts
│   ├── check-skill-versions.ts
│   ├── check-skills-sync.ts
│   ├── clean.ts
│   ├── devcheck.ts
│   ├── lint-mcp.ts
│   ├── lint-packaging.ts
│   ├── list-skills.ts
│   ├── release-github.ts
│   ├── split-changelog.ts
│   └── tree.ts
├── skills/
│   ├── add-app-tool/
│   │   └── SKILL.md
│   ├── add-prompt/
│   │   └── SKILL.md
│   ├── add-resource/
│   │   └── SKILL.md
│   ├── add-service/
│   │   └── SKILL.md
│   ├── add-test/
│   │   └── SKILL.md
│   ├── add-tool/
│   │   └── SKILL.md
│   ├── api-auth/
│   │   └── SKILL.md
│   ├── api-canvas/
│   │   └── SKILL.md
│   ├── api-config/
│   │   └── SKILL.md
│   ├── api-context/
│   │   └── SKILL.md
│   ├── api-errors/
│   │   └── SKILL.md
│   ├── api-linter/
│   │   └── SKILL.md
│   ├── api-mirror/
│   │   └── SKILL.md
│   ├── api-services/
│   │   ├── references/
│   │   │   ├── graph.md
│   │   │   ├── llm.md
│   │   │   └── speech.md
│   │   └── SKILL.md
│   ├── api-telemetry/
│   │   └── SKILL.md
│   ├── api-testing/
│   │   └── SKILL.md
│   ├── api-utils/
│   │   ├── references/
│   │   │   ├── formatting.md
│   │   │   ├── parsing.md
│   │   │   └── security.md
│   │   └── SKILL.md
│   ├── api-workers/
│   │   └── SKILL.md
│   ├── code-simplifier/
│   │   └── SKILL.md
│   ├── design-mcp-server/
│   │   └── SKILL.md
│   ├── field-test/
│   │   └── SKILL.md
│   ├── git-wrapup/
│   │   └── SKILL.md
│   ├── maintenance/
│   │   └── SKILL.md
│   ├── orchestrations/
│   │   ├── workflows/
│   │   │   ├── field-test-fix.md
│   │   │   ├── fix-wrapup-release.md
│   │   │   ├── greenfield-build.md
│   │   │   └── maintenance-release.md
│   │   └── SKILL.md
│   ├── polish-docs-meta/
│   │   ├── references/
│   │   │   ├── agent-protocol.md
│   │   │   ├── package-meta.md
│   │   │   ├── readme.md
│   │   │   └── server-json.md
│   │   └── SKILL.md
│   ├── release-and-publish/
│   │   └── SKILL.md
│   ├── report-issue-framework/
│   │   └── SKILL.md
│   ├── report-issue-local/
│   │   └── SKILL.md
│   ├── security-pass/
│   │   └── SKILL.md
│   ├── setup/
│   │   └── SKILL.md
│   └── tool-defs-analysis/
│       └── SKILL.md
├── src/
│   ├── config/
│   │   └── server-config.ts
│   ├── mcp-server/
│   │   ├── prompts/
│   │   │   └── definitions/
│   │   ├── resources/
│   │   │   └── definitions/
│   │   └── tools/
│   │       └── definitions/
│   │           ├── bls-dataframe-describe.tool.ts
│   │           ├── bls-dataframe-drop.tool.ts
│   │           ├── bls-dataframe-query.tool.ts
│   │           ├── bls-get-latest.tool.ts
│   │           ├── bls-get-series.tool.ts
│   │           ├── bls-list-surveys.tool.ts
│   │           └── bls-search-series.tool.ts
│   ├── services/
│   │   ├── bls-api/
│   │   │   ├── bls-api-service.ts
│   │   │   └── types.ts
│   │   ├── bls-catalog/
│   │   │   ├── bls-catalog-service.ts
│   │   │   └── types.ts
│   │   ├── bls-observations/
│   │   │   ├── bls-observations-service.ts
│   │   │   ├── ingester.ts
│   │   │   ├── subprocess.ts
│   │   │   └── types.ts
│   │   └── canvas-bridge/
│   │       ├── canvas-bridge.ts
│   │       └── sql-gate-extras.ts
│   └── index.ts
├── tests/
│   ├── prompts/
│   ├── resources/
│   ├── services/
│   │   ├── bls-api/
│   │   │   └── bls-api-service.test.ts
│   │   ├── bls-catalog/
│   │   │   └── bls-catalog-service.test.ts
│   │   ├── bls-observations/
│   │   │   ├── bls-observations-routing.test.ts
│   │   │   ├── ingester.test.ts
│   │   │   └── subprocess.test.ts
│   │   └── canvas-bridge/
│   │       └── sql-gate-extras.test.ts
│   └── tools/
│       ├── bls-dataframe-describe.tool.test.ts
│       ├── bls-dataframe-drop.tool.test.ts
│       ├── bls-dataframe-query.tool.test.ts
│       ├── bls-get-latest.tool.test.ts
│       ├── bls-get-series.tool.test.ts
│       ├── bls-list-surveys.tool.test.ts
│       └── bls-search-series.tool.test.ts
├── .dockerignore
├── .env.example
├── .gitignore
├── .mcpbignore
├── AGENTS.md
├── biome.json
├── bun.lock
├── bunfig.toml
├── CHANGELOG.md
├── CITATION.cff
├── CLAUDE.md
├── devcheck.config.json
├── Dockerfile
├── LICENSE
├── manifest.json
├── package.json
├── README.md
├── server.json
├── tsconfig.build.json
├── tsconfig.json
└── vitest.config.ts
```

_Note: This tree excludes files and directories matched by .gitignore and default patterns._
