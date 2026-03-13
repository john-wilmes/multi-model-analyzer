# Task: Fix MCP server standalone execution

## Problem

The MMA MCP server (`packages/mcp`) can't be started via the CLI when invoked from outside the workspace:

```
node apps/cli/dist/index.js serve --db data/mma.db
```

Fails with:
```
Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@mma/storage'
```

This happens even when running from the workspace root (`cd ~/Documents/multi-model-analyzer && node apps/cli/dist/index.js serve`). The pnpm workspace symlinks aren't resolving for the compiled dist output.

## Context

The agentic-coding-playbook project wants to use MMA's MCP server so coding agents in any project can query cross-repo dependency graphs, blast radius, architecture, etc. The server is registered in the playbook's MCP registry at `templates/registry/mcp-servers.json` under the key `"mma"`, currently disabled.

The config expects to run:
```json
{
  "command": "node",
  "args": ["apps/cli/dist/index.js", "serve", "--db", "data/mma.db"],
  "cwd": "~/Documents/multi-model-analyzer"
}
```

## Desired outcome

`mma serve --db data/mma.db` works when invoked as an MCP server (stdio transport). Options:

1. **Fix workspace resolution** — bundle or resolve `@mma/*` imports in the dist output so they don't need pnpm symlinks at runtime
2. **Standalone entry point** — a single `mcp-server.js` script that can be run with `node` without workspace context (e.g., inline the imports or use a bundler)
3. **npx/global install** — make `mma` installable globally with `pnpm -g` or `npx`

Any approach is fine as long as the MCP server can be started with a simple `node` or `npx` command from Claude Code's MCP config.

## Secondary: shared repos config

The playbook will maintain its own `repos.config.json` listing repos for agents to have cross-repo intelligence on. MMA's `mma.config.json` may overlap. Consider whether MMA should accept an external repos config path (e.g., `--config path/to/repos.config.json`) so both can share a repo list without duplication.
