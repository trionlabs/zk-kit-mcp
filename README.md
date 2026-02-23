# zk-kit-mcp

[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![npm](https://img.shields.io/npm/v/zk-kit-mcp)](https://www.npmjs.com/package/zk-kit-mcp)
[![node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)

MCP server for [ZK-Kit](https://zkkit.org), zero-knowledge toolkit by PSE at the Ethereum Foundation.
Gives LLMs structured access to ~30 packages across TypeScript, Circom, Solidity, Noir, and Rust.

## Tools

### Discovery & Navigation

- `list_packages` - List and search packages. Filter by keyword, language, or category.
- `get_ecosystem_overview` - High-level map of all packages grouped by language and category.
- `compare_packages` - Side-by-side comparison of two or more packages.
- `get_cross_language_coverage` - Concept * language matrix showing which implementations exist and where gaps are.
- `get_dependency_graph` - Internal dependency graph between ZK-Kit packages, with reverse dependencies.

### Documentation & Source

- `get_package_readme` - Full README with API docs, examples, and audit status. Supports a summary mode.
- `get_package_api` - Main entry/export file (src/index.ts, src/lib.rs, main contract, main circuit).
- `get_package_source` - Browse directory tree or read any file in a package.
- `get_package_changelog` - Version-by-version changes, breaking changes, and migration notes.
- `search_code` - Search across ZK-Kit source code using GitHub Code Search.

### Package Health & Activity

- `get_releases` - Recent releases for a repo or filtered by package.
- `get_package_commits` - Recent commits for a specific package.
- `get_package_downloads` - Download stats from npm or crates.io.
- `get_build_status` - Latest CI/CD workflow runs from GitHub Actions.
- `get_repo_stats` - Stars, forks, open issues, last push date, license, and topics.

### Dependencies & Issues

- `get_package_dependencies` - Runtime, dev, and peer dependencies from the package manifest.
- `search_issues` - Search GitHub issues across ZK-Kit repositories. Scope by package, language, or repo.

## Prompts & Resources

### Prompts

1. `zk-integration-guide` - Guided workflow for integrating a ZK-Kit package into your project.
2. `zk-concept-explainer` - Learn about a ZK concept (Merkle trees, Poseidon, EdDSA, etc.) through ZK-Kit implementations.
3. `troubleshoot-package` - Guided troubleshooting for issues with a ZK-Kit package.
4. `migration-guide` - Upgrade to a newer version or switch to a different language implementation.

All prompts support package name autocomplete.

### Resources

- `zk-kit://overview` - Static ecosystem overview of all packages.
- `zk-kit://packages/{language}/{dirName}` - Package details with language and directory name completions.

## Installation

### npx

```bash
npx zk-kit-mcp
```

### Global install

```bash
npm install -g zk-kit-mcp
```

### From source

```bash
git clone https://github.com/zk-kit/zk-kit-mcp.git
cd zk-kit-mcp
npm install
npm run build
node build/index.js
```

## Configuration

### Claude Desktop

Add to your Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

```json
{
  "mcpServers": {
    "zk-kit": {
      "command": "npx",
      "args": ["-y", "zk-kit-mcp"],
      "env": {
        "GITHUB_TOKEN": "your-token-here"
      }
    }
  }
}
```

### VS Code

Add to `.vscode/mcp.json` in your workspace:

```json
{
  "servers": {
    "zk-kit": {
      "command": "npx",
      "args": ["-y", "zk-kit-mcp"],
      "env": {
        "GITHUB_TOKEN": "your-token-here"
      }
    }
  }
}
```

### Cursor

Add to your Cursor MCP config:

```json
{
  "mcpServers": {
    "zk-kit": {
      "command": "npx",
      "args": ["-y", "zk-kit-mcp"],
      "env": {
        "GITHUB_TOKEN": "your-token-here"
      }
    }
  }
}
```

### Claude Code

```bash
claude mcp add zk-kit -- npx -y zk-kit-mcp
```

With a GitHub token:

```bash
claude mcp add zk-kit --env GITHUB_TOKEN=your-token-here -- npx -y zk-kit-mcp
```

## GitHub Token

Optional but recommended. Set `GITHUB_TOKEN` as an environment variable.

- Without token: 60 requests/hour (GitHub API anonymous limit)
- With token: 5,000 requests/hour

A [fine-grained personal access token](https://github.com/settings/tokens?type=beta) with no permissions is sufficient, all ZK-Kit repos are public.

READMEs are fetched from raw.githubusercontent.com, which is not rate-limited by the GitHub API.

## How It Works

1. Discovers packages from 5 GitHub repos at startup (`zk-kit`, `zk-kit.circom`, `zk-kit.solidity`, `zk-kit.noir`, `zk-kit.rust`)
2. Reads manifests (package.json, Cargo.toml, Nargo.toml) for metadata
3. Holds everything in memory. No database, no config files
4. Fetches READMEs and changelogs on demand, caches with 10-minute TTL

Startup takes 2-4 seconds. If a repo is unavailable, packages from other repos still load.

## Development

```bash
npm run dev          # run via tsx (no build needed)
npm test             # vitest (343 tests)
npm run lint         # biome check
npm run build        # tsc + chmod
npx @modelcontextprotocol/inspector node build/index.js  # interactive testing
```

## License

[MIT](LICENSE)
