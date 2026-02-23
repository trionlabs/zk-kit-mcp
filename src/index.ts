#!/usr/bin/env node

import { readFileSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { completable } from "@modelcontextprotocol/sdk/server/completable.js";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { TTLCache } from "./cache.js";
import { REPOS } from "./config.js";
import { discoverAllPackages } from "./discovery.js";
import {
  detectLanguageFromExtension,
  extractFirstCodeBlock,
  fetchDirectoryTree,
  fetchPackageCommits,
  fetchPackageDependencies,
  fetchPackageDownloads,
  fetchRawFile,
  fetchReadme,
  fetchReleases,
  fetchRepoStats,
  fetchWorkflowRuns,
  formatCodeSearchResults,
  formatCommits,
  formatDependencies,
  formatDirectoryTree,
  formatIssue,
  formatPackageDownloads,
  formatRelease,
  formatRepoStats,
  formatWorkflowRuns,
  searchCode,
  searchIssues,
} from "./github.js";
import { logger } from "./logger.js";
import { PackageRegistry } from "./registry.js";
import type { Package } from "./types.js";
import { Category, Language } from "./types.js";

// Shared Helpers

/** Max response size in characters. Content beyond this is truncated with a hint. */
const MAX_RESPONSE_LENGTH = 50_000;

const EMPTY_REGISTRY_HINT =
  " The package registry is empty, this usually means GitHub API requests failed at startup. Check server logs and ensure GITHUB_TOKEN is set for higher rate limits.";

type ToolContent = { type: "text"; text: string }[];
type ToolResult = { content: ToolContent; isError?: true };

function textResult(text: string): ToolResult {
  return { content: [{ type: "text" as const, text }] };
}

function errorResult(e: unknown): ToolResult {
  const msg = e instanceof Error ? e.message : String(e);
  return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true };
}

function resolvePackage(registry: PackageRegistry, name: string): { pkg: Package } | { result: ToolResult } {
  const pkg = registry.getByName(name);
  if (pkg) return { pkg };

  if (registry.count === 0) {
    return { result: textResult(`Package "${name}" not found.${EMPTY_REGISTRY_HINT}`) };
  }

  const suggestions = registry.suggest(name);
  const text = suggestions.length
    ? `Package "${name}" not found. Did you mean:\n${suggestions.map((s) => `- ${s.name}`).join("\n")}`
    : `Package "${name}" not found. Use list_packages to see available packages.`;
  return { result: textResult(text) };
}

function resolveRepoSlugs(language?: string, repo?: string): { slugs: string[] } | { result: ToolResult } {
  if (repo) {
    const validSlugs = REPOS.map((r) => r.slug);
    if (!validSlugs.includes(repo)) {
      return { result: textResult(`Unknown repo: "${repo}". Valid repos: ${validSlugs.join(", ")}`) };
    }
    return { slugs: [repo] };
  }
  if (language) {
    const found = REPOS.find((r) => r.language === language);
    if (!found) {
      return {
        result: textResult(`Unknown language: ${language}. Available: ${REPOS.map((r) => r.language).join(", ")}`),
      };
    }
    return { slugs: [found.slug] };
  }
  return { slugs: REPOS.map((r) => r.slug) };
}

function completePackageName(registry: PackageRegistry) {
  return (value: string | undefined) =>
    registry.all
      .filter((p) => !value || p.name.toLowerCase().includes(value.toLowerCase()))
      .map((p) => p.name)
      .slice(0, 20);
}

// Server

export function createServer(registry: PackageRegistry): { server: McpServer; clearCaches: () => void } {
  const readmeCache = new TTLCache<string, string>(10 * 60 * 1000);
  const releaseCache = new TTLCache<string, string>(5 * 60 * 1000);
  const depsCache = new TTLCache<string, string>(10 * 60 * 1000);
  const statsCache = new TTLCache<string, string>(30 * 60 * 1000);
  const treeCache = new TTLCache<string, string>(10 * 60 * 1000);
  const codeSearchCache = new TTLCache<string, string>(5 * 60 * 1000);
  const commitsCache = new TTLCache<string, string>(5 * 60 * 1000);
  const downloadsCache = new TTLCache<string, string>(30 * 60 * 1000);
  const buildStatusCache = new TTLCache<string, string>(5 * 60 * 1000);
  const issueSearchCache = new TTLCache<string, string>(5 * 60 * 1000);
  const changelogCache = new TTLCache<string, string>(10 * 60 * 1000);

  async function getOrFetchReadme(pkg: Package): Promise<string | undefined> {
    const cacheKey = `${pkg.language}/${pkg.dirName}`;
    let readme = readmeCache.get(cacheKey);
    if (!readme) {
      const repo = registry.getRepoForLanguage(pkg.language);
      if (repo) {
        readme = (await fetchReadme(repo.slug, repo.branch, repo.packagePath, pkg.dirName)) ?? undefined;
        if (readme) readmeCache.set(cacheKey, readme);
      }
    }
    return readme;
  }

  const pkgJsonPath = resolve(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
  let serverVersion = "0.0.0";
  try {
    serverVersion = JSON.parse(readFileSync(pkgJsonPath, "utf-8")).version ?? serverVersion;
  } catch {
    /* fallback */
  }

  const server = new McpServer({
    name: "zk-kit-mcp",
    version: serverVersion,
  });

  // Tools

  server.registerTool(
    "list_packages",
    {
      title: "List Packages",
      description:
        "List and search ZK-Kit packages. Filter by keyword, language, or category. Returns package names, descriptions, languages, and install commands.",
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      inputSchema: {
        query: z.string().optional().describe("Search keywords (space-separated, all must match)"),
        language: Language.optional().describe("Filter by language"),
        category: Category.optional().describe("Filter by category"),
      },
    },
    async ({ query, language, category }) => {
      try {
        const results = registry.search(query, language, category);
        if (results.length === 0) {
          const hint = registry.count === 0 ? EMPTY_REGISTRY_HINT : "";
          return textResult(`No packages found matching the given criteria.${hint}`);
        }
        const text = results
          .map((p) => {
            const ver = p.version ? ` v${p.version}` : "";
            return `**${p.name}**${ver} (${p.language}, ${p.category})\n${p.description || "(no description)"}\nInstall: \`${p.installCommand}\``;
          })
          .join("\n\n");
        return textResult(text);
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "get_package_readme",
    {
      title: "Get Package README",
      description:
        "Fetch the full README for a ZK-Kit package. Contains API docs, usage examples, install instructions, and audit status. Use this when you need detailed documentation for a specific package. Set summary=true for a concise version with just install command, description, and first code example.",
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
      inputSchema: {
        name: z.string().describe("Package name (e.g., '@zk-kit/lean-imt', 'lean-imt', 'lean-imt.sol')"),
        summary: z
          .boolean()
          .optional()
          .describe(
            "If true, return concise summary: install command + description + first code example (saves tokens)",
          ),
      },
    },
    async ({ name, summary }) => {
      try {
        const resolved = resolvePackage(registry, name);
        if ("result" in resolved) return resolved.result;
        const { pkg } = resolved;

        const readme = await getOrFetchReadme(pkg);

        if (readme) {
          if (summary) {
            const ver = pkg.version ? ` v${pkg.version}` : "";
            let text = `# ${pkg.name}${ver}\n\n`;
            text += `${pkg.description || "(no description)"}\n\n`;
            text += `**Install:** \`${pkg.installCommand}\`\n`;
            const codeBlock = extractFirstCodeBlock(readme);
            if (codeBlock) {
              text += `\n## Quick Example\n\n\`\`\`${codeBlock.language}\n${codeBlock.code}\n\`\`\``;
            }
            text += `\n\n*Use \`get_package_readme\` without \`summary\` for the full documentation.*`;
            return textResult(text);
          }
          if (readme.length > MAX_RESPONSE_LENGTH) {
            const truncated = readme.slice(0, MAX_RESPONSE_LENGTH);
            return textResult(
              truncated +
                `\n\n---\n*[Content truncated at ${MAX_RESPONSE_LENGTH} characters. Use \`get_package_readme\` with \`summary: true\` for a concise version, or \`get_package_source\` to read specific files.]*`,
            );
          }
          return textResult(readme);
        }

        const verLine = pkg.version ? `\n**Version:** ${pkg.version}` : "";
        const fallback = `# ${pkg.name}\n\n**Language:** ${pkg.language}\n**Category:** ${pkg.category}${verLine}\n**Description:** ${pkg.description || "(no description)"}\n**Install:** \`${pkg.installCommand}\`\n**Repo:** ${pkg.repo}\n\n(README could not be fetched from GitHub)`;
        return textResult(fallback);
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "get_ecosystem_overview",
    {
      title: "Ecosystem Overview",
      description:
        "Get a high-level map of the entire ZK-Kit ecosystem: all packages grouped by language and category, with cross-language links.",
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      try {
        if (registry.count === 0) {
          return textResult(`No packages available.${EMPTY_REGISTRY_HINT}`);
        }
        return textResult(registry.getEcosystemOverview());
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "compare_packages",
    {
      title: "Compare Packages",
      description:
        "Side-by-side comparison of two or more ZK-Kit packages. Shows language, category, description, install commands, and cross-language variants.",
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      inputSchema: {
        names: z.array(z.string()).min(2).describe("Package names to compare (at least 2)"),
      },
    },
    async ({ names }) => {
      try {
        if (registry.count === 0) {
          return textResult(`Cannot compare packages.${EMPTY_REGISTRY_HINT}`);
        }
        return textResult(registry.compare(names));
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "get_releases",
    {
      title: "Get Releases",
      description:
        "Fetch recent releases for a ZK-Kit repo. Specify a language to get releases for that repo, a specific repo slug, or a package name to filter releases for that package. Defaults to all repos.",
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
      inputSchema: {
        language: Language.optional().describe("Language of the repo to check"),
        repo: z.string().optional().describe("Specific repo slug (e.g., 'zk-kit/zk-kit')"),
        package: z.string().optional().describe("Package name to filter releases (e.g., '@zk-kit/lean-imt')"),
        limit: z.number().min(1).max(30).optional().describe("Number of releases to fetch (default 10)"),
      },
    },
    async ({ language, repo, limit, package: packageName }) => {
      try {
        let packageFilter: string | undefined;
        let resolvedSlugs: string[];

        if (packageName) {
          const resolved = resolvePackage(registry, packageName);
          if ("result" in resolved) return resolved.result;
          const { pkg } = resolved;
          const repoConfig = registry.getRepoForLanguage(pkg.language);
          if (!repoConfig) return textResult(`No repo config for language: ${pkg.language}`);
          resolvedSlugs = [repoConfig.slug];
          packageFilter = pkg.name;
        } else {
          const resolved = resolveRepoSlugs(language, repo);
          if ("result" in resolved) return resolved.result;
          resolvedSlugs = resolved.slugs;
        }

        const effectiveLimit = limit ?? 10;
        const parts = await Promise.all(
          resolvedSlugs.map(async (slug) => {
            const cacheKey = `${slug}:${effectiveLimit}:${packageFilter ?? ""}`;
            let cached = releaseCache.get(cacheKey);
            if (!cached) {
              const releases = await fetchReleases(slug, effectiveLimit, packageFilter);
              const label = packageFilter ?? slug;
              cached =
                releases.length === 0
                  ? `No releases found for ${label}.`
                  : releases.map(formatRelease).join("\n\n---\n\n");
              releaseCache.set(cacheKey, cached);
            }
            return cached;
          }),
        );

        return textResult(parts.join("\n\n---\n\n"));
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "search_issues",
    {
      title: "Search Issues",
      description:
        "Search GitHub issues across ZK-Kit repositories. Useful for finding bugs, feature requests, or discussions about specific packages. Scope to a specific package (most precise), language, or repo.",
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
      inputSchema: {
        query: z.string().describe("Search query"),
        state: z.enum(["open", "closed", "all"]).optional().describe("Issue state filter (default: open)"),
        package: z
          .string()
          .optional()
          .describe(
            "Scope search to a specific package (e.g., '@zk-kit/lean-imt'). Automatically resolves repo and adds package name to query.",
          ),
        language: Language.optional().describe("Scope search to this language's repo (e.g., 'typescript', 'solidity')"),
        repo: z.string().optional().describe("Scope search to a specific repo slug (e.g., 'zk-kit/zk-kit')"),
      },
    },
    async ({ query, state, language, repo, package: packageName }) => {
      try {
        let scopeRepo: string | undefined;
        let effectiveQuery = query;

        if (packageName) {
          const resolved = resolvePackage(registry, packageName);
          if ("result" in resolved) return resolved.result;
          const { pkg } = resolved;
          const repoConfig = registry.getRepoForLanguage(pkg.language);
          if (repoConfig) scopeRepo = repoConfig.slug;
          // Add package dirName to query for more precise results
          effectiveQuery = `${query} ${pkg.dirName}`;
        } else if (repo || language) {
          const resolved = resolveRepoSlugs(language, repo);
          if ("result" in resolved) return resolved.result;
          scopeRepo = resolved.slugs[0];
        }

        const effectiveState = state ?? "open";
        const cacheKey = `${effectiveQuery}:${effectiveState}:${scopeRepo ?? ""}`;
        let cached = issueSearchCache.get(cacheKey);

        if (!cached) {
          const issues = await searchIssues(effectiveQuery, effectiveState, scopeRepo);
          cached = issues.length === 0 ? `No issues found for "${query}".` : issues.map(formatIssue).join("\n\n");
          issueSearchCache.set(cacheKey, cached);
        }

        return textResult(cached);
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "get_package_dependencies",
    {
      title: "Get Package Dependencies",
      description:
        "Fetch the dependency list for a ZK-Kit package. Shows runtime, dev, and peer dependencies from the package manifest (package.json, Cargo.toml, or Nargo.toml).",
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
      inputSchema: {
        name: z.string().describe("Package name (e.g., '@zk-kit/lean-imt', 'lean-imt')"),
      },
    },
    async ({ name }) => {
      try {
        const resolved = resolvePackage(registry, name);
        if ("result" in resolved) return resolved.result;
        const { pkg } = resolved;

        const cacheKey = `${pkg.language}/${pkg.dirName}`;
        let cached = depsCache.get(cacheKey);

        if (!cached) {
          const repo = registry.getRepoForLanguage(pkg.language);
          if (!repo) return textResult(`No repo config for language: ${pkg.language}`);
          const deps = await fetchPackageDependencies(
            repo.slug,
            repo.branch,
            repo.packagePath,
            pkg.dirName,
            pkg.language,
          );
          cached = deps
            ? formatDependencies(pkg.name, pkg.language, deps)
            : `Could not fetch dependencies for ${pkg.name}. The manifest file may not exist.`;
          depsCache.set(cacheKey, cached);
        }

        return textResult(cached);
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "get_repo_stats",
    {
      title: "Get Repo Stats",
      description:
        "Fetch GitHub repository statistics for ZK-Kit repos: stars, forks, open issues, last push date, license, and topics. Useful for assessing project health and activity.",
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
      inputSchema: {
        language: Language.optional().describe("Language to get repo stats for"),
        repo: z.string().optional().describe("Specific repo slug (e.g., 'zk-kit/zk-kit')"),
      },
    },
    async ({ language, repo }) => {
      try {
        const resolved = resolveRepoSlugs(language, repo);
        if ("result" in resolved) return resolved.result;

        const parts = await Promise.all(
          resolved.slugs.map(async (slug) => {
            let cached = statsCache.get(slug);
            if (!cached) {
              const stats = await fetchRepoStats(slug);
              cached = formatRepoStats(stats);
              statsCache.set(slug, cached);
            }
            return cached;
          }),
        );

        return textResult(parts.join("\n---\n\n"));
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "get_package_source",
    {
      title: "Get Package Source",
      description:
        "Browse source code of a ZK-Kit package. Without filePath, returns the full directory tree. With filePath, returns the file content. Use this to read source code, type definitions, tests, or any file in a package.",
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
      inputSchema: {
        name: z.string().describe("Package name (e.g., '@zk-kit/lean-imt', 'lean-imt')"),
        filePath: z.string().optional().describe("Relative path to a file within the package (e.g., 'src/index.ts')"),
      },
    },
    async ({ name, filePath }) => {
      try {
        const resolved = resolvePackage(registry, name);
        if ("result" in resolved) return resolved.result;
        const { pkg } = resolved;

        const repo = registry.getRepoForLanguage(pkg.language);
        if (!repo) return textResult(`No repo config for language: ${pkg.language}`);

        const packageBasePath = `${repo.packagePath}/${pkg.dirName}`;

        if (!filePath) {
          const treeCacheKey = `${pkg.language}/${pkg.dirName}`;
          let cached = treeCache.get(treeCacheKey);
          if (!cached) {
            const entries = await fetchDirectoryTree(repo.slug, repo.branch, packageBasePath);
            cached = `# ${pkg.name} - File Tree\n\n\`\`\`\n${formatDirectoryTree(entries)}\n\`\`\`\n\nUse \`get_package_source\` with a \`filePath\` to read any file.`;
            treeCache.set(treeCacheKey, cached);
          }
          return textResult(cached);
        }

        const fullFilePath = `${packageBasePath}/${filePath}`;
        const content = await fetchRawFile(repo.slug, repo.branch, fullFilePath);
        if (!content) {
          return textResult(
            `File not found: \`${filePath}\` in ${pkg.name}.\n\nUse \`get_package_source\` without \`filePath\` to see the directory tree.`,
          );
        }

        const lang = detectLanguageFromExtension(filePath);
        const fileContent =
          content.length > MAX_RESPONSE_LENGTH
            ? `${content.slice(0, MAX_RESPONSE_LENGTH)}\n... [truncated at ${MAX_RESPONSE_LENGTH} characters]`
            : content;
        const codeBlock = lang ? `\`\`\`${lang}\n${fileContent}\n\`\`\`` : `\`\`\`\n${fileContent}\n\`\`\``;
        return textResult(`# ${pkg.name} - \`${filePath}\`\n\n${codeBlock}`);
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "search_code",
    {
      title: "Search Code",
      description:
        "Search across ZK-Kit source code using GitHub Code Search. Find implementations, usages, and patterns. Optionally scope to a specific package for more relevant results.",
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
      inputSchema: {
        query: z.string().describe("Code search query (e.g., 'PoseidonT3', 'function insert', 'pragma solidity')"),
        language: z
          .string()
          .optional()
          .describe("Filter by programming language (e.g., 'typescript', 'solidity', 'rust')"),
        package: z
          .string()
          .optional()
          .describe("Scope search to a specific package (e.g., '@zk-kit/lean-imt', 'lean-imt')"),
      },
    },
    async ({ query, language, package: packageName }) => {
      try {
        let scopeRepo: string | undefined;
        let scopePath: string | undefined;

        if (packageName) {
          const resolved = resolvePackage(registry, packageName);
          if ("result" in resolved) return resolved.result;
          const { pkg } = resolved;
          const repo = registry.getRepoForLanguage(pkg.language);
          if (repo) {
            scopeRepo = repo.slug;
            scopePath = `${repo.packagePath}/${pkg.dirName}`;
          }
        }

        const cacheKey = `${query}:${language ?? ""}:${scopeRepo ?? ""}:${scopePath ?? ""}`;
        let cached = codeSearchCache.get(cacheKey);
        if (!cached) {
          const results = await searchCode(query, language, scopeRepo, scopePath);
          cached = formatCodeSearchResults(results);
          codeSearchCache.set(cacheKey, cached);
        }
        return textResult(cached);
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "get_package_commits",
    {
      title: "Get Package Commits",
      description:
        "Fetch recent commits for a specific ZK-Kit package. Shows what changed recently, who contributed, and when. Useful for assessing package activity and recent bug fixes.",
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
      inputSchema: {
        name: z.string().describe("Package name (e.g., '@zk-kit/lean-imt', 'lean-imt')"),
        limit: z.number().min(1).max(50).optional().describe("Number of commits to fetch (default 10)"),
      },
    },
    async ({ name, limit }) => {
      try {
        const resolved = resolvePackage(registry, name);
        if ("result" in resolved) return resolved.result;
        const { pkg } = resolved;

        const repo = registry.getRepoForLanguage(pkg.language);
        if (!repo) return textResult(`No repo config for language: ${pkg.language}`);

        const effectiveLimit = limit ?? 10;
        const cacheKey = `${pkg.language}/${pkg.dirName}:${effectiveLimit}`;
        let cached = commitsCache.get(cacheKey);
        if (!cached) {
          const path = `${repo.packagePath}/${pkg.dirName}`;
          const commits = await fetchPackageCommits(repo.slug, path, effectiveLimit);
          cached = formatCommits(pkg.name, commits);
          commitsCache.set(cacheKey, cached);
        }
        return textResult(cached);
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "get_package_downloads",
    {
      title: "Get Package Downloads",
      description:
        "Fetch download statistics for a ZK-Kit package from npm (TypeScript/Circom/Solidity) or crates.io (Rust). Shows weekly and monthly download counts as a measure of package popularity and adoption.",
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
      inputSchema: {
        name: z.string().describe("Package name (e.g., '@zk-kit/lean-imt', 'lean-imt')"),
      },
    },
    async ({ name }) => {
      try {
        const resolved = resolvePackage(registry, name);
        if ("result" in resolved) return resolved.result;
        const { pkg } = resolved;

        const cacheKey = pkg.name;
        let cached = downloadsCache.get(cacheKey);
        if (!cached) {
          const downloads = await fetchPackageDownloads(pkg.name, pkg.language);
          cached = formatPackageDownloads(pkg.name, downloads);
          downloadsCache.set(cacheKey, cached);
        }
        return textResult(cached);
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "get_build_status",
    {
      title: "Get Build Status",
      description:
        "Fetch the latest CI/CD workflow run status from GitHub Actions for ZK-Kit repos. Shows recent workflow runs with pass/fail status. Useful for assessing whether the project builds and tests pass right now.",
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
      inputSchema: {
        language: Language.optional().describe("Language to get CI status for"),
        repo: z.string().optional().describe("Specific repo slug (e.g., 'zk-kit/zk-kit')"),
        limit: z.number().min(1).max(20).optional().describe("Number of recent runs to fetch (default 5)"),
      },
    },
    async ({ language, repo, limit }) => {
      try {
        const resolved = resolveRepoSlugs(language, repo);
        if ("result" in resolved) return resolved.result;

        const effectiveLimit = limit ?? 5;
        const parts = await Promise.all(
          resolved.slugs.map(async (slug) => {
            const cacheKey = `${slug}:${effectiveLimit}`;
            let cached = buildStatusCache.get(cacheKey);
            if (!cached) {
              const runs = await fetchWorkflowRuns(slug, effectiveLimit);
              cached = formatWorkflowRuns(slug, runs);
              buildStatusCache.set(cacheKey, cached);
            }
            return cached;
          }),
        );

        return textResult(parts.join("\n---\n\n"));
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "get_cross_language_coverage",
    {
      title: "Cross-Language Coverage",
      description:
        "Show a concept * language matrix revealing which ZK-Kit concepts are implemented in which languages and where gaps exist. Zero API cost, computed from the package registry.",
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      try {
        if (registry.count === 0) {
          return textResult(`No packages available.${EMPTY_REGISTRY_HINT}`);
        }
        return textResult(registry.getCrossLanguageCoverage());
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "get_dependency_graph",
    {
      title: "Dependency Graph",
      description:
        "Show the internal dependency graph between ZK-Kit packages. Without a package name, shows the full graph: foundational, leaf, and independent packages. With a package name, shows what that package depends on and what depends on it (reverse dependencies).",
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      inputSchema: {
        name: z
          .string()
          .optional()
          .describe("Package name to show reverse dependencies for (e.g., 'poseidon-lite', '@zk-kit/lean-imt')"),
      },
    },
    async ({ name }) => {
      try {
        if (registry.count === 0) {
          return textResult(`No packages available.${EMPTY_REGISTRY_HINT}`);
        }
        if (name) {
          const resolved = resolvePackage(registry, name);
          if ("result" in resolved) return resolved.result;
          return textResult(registry.getReverseDependencies(resolved.pkg.crossLanguageId));
        }
        return textResult(registry.getDependencyGraph());
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "get_package_api",
    {
      title: "Get Package API",
      description:
        "Fetch the main entry/export file for a ZK-Kit package. Returns the primary API surface: src/index.ts for TypeScript, src/lib.rs for Rust, the main contract for Solidity, the main circuit for Circom/Noir. Use this to quickly understand a package's public API without browsing the full source tree.",
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
      inputSchema: {
        name: z.string().describe("Package name (e.g., '@zk-kit/lean-imt', 'lean-imt')"),
      },
    },
    async ({ name }) => {
      try {
        const resolved = resolvePackage(registry, name);
        if ("result" in resolved) return resolved.result;
        const { pkg } = resolved;

        const repo = registry.getRepoForLanguage(pkg.language);
        if (!repo) return textResult(`No repo config for language: ${pkg.language}`);

        const packageBasePath = `${repo.packagePath}/${pkg.dirName}`;

        // Language-specific entry file candidates, ordered by priority
        const candidates: string[] = (() => {
          switch (pkg.language) {
            case "typescript":
              return ["src/index.ts", "src/index.js"];
            case "rust":
              return ["src/lib.rs", "src/main.rs"];
            case "solidity":
              return [
                `contracts/${pkg.dirName
                  .split("-")
                  .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
                  .join("")}.sol`,
                `contracts/${pkg.dirName}.sol`,
              ];
            case "circom":
              return [`src/${pkg.dirName}.circom`, `circuits/${pkg.dirName}.circom`];
            case "noir":
              return ["src/lib.nr", "src/main.nr"];
          }
        })();

        for (const candidate of candidates) {
          const content = await fetchRawFile(repo.slug, repo.branch, `${packageBasePath}/${candidate}`);
          if (content) {
            const lang = detectLanguageFromExtension(candidate);
            const fileContent =
              content.length > MAX_RESPONSE_LENGTH
                ? `${content.slice(0, MAX_RESPONSE_LENGTH)}\n... [truncated at ${MAX_RESPONSE_LENGTH} characters]`
                : content;
            const codeBlock = lang ? `\`\`\`${lang}\n${fileContent}\n\`\`\`` : `\`\`\`\n${fileContent}\n\`\`\``;
            return textResult(`# ${pkg.name} - API (\`${candidate}\`)\n\n${codeBlock}`);
          }
        }

        return textResult(
          `Could not find the main entry file for ${pkg.name}.\n\nTried: ${candidates.map((c) => `\`${c}\``).join(", ")}\n\nUse \`get_package_source\` without \`filePath\` to see the full directory tree and locate the right file.`,
        );
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "get_package_changelog",
    {
      title: "Get Package Changelog",
      description:
        "Fetch the CHANGELOG.md for a ZK-Kit package. Shows version-by-version changes, breaking changes, and migration notes. More granular than repo-level releases.",
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
      inputSchema: {
        name: z.string().describe("Package name (e.g., '@zk-kit/lean-imt', 'lean-imt')"),
      },
    },
    async ({ name }) => {
      try {
        const resolved = resolvePackage(registry, name);
        if ("result" in resolved) return resolved.result;
        const { pkg } = resolved;

        const repo = registry.getRepoForLanguage(pkg.language);
        if (!repo) return textResult(`No repo config for language: ${pkg.language}`);

        const cacheKey = `${pkg.language}/${pkg.dirName}`;
        let cached = changelogCache.get(cacheKey);

        if (!cached) {
          const basePath = `${repo.packagePath}/${pkg.dirName}`;
          const candidates = [`${basePath}/CHANGELOG.md`, `${basePath}/changelog.md`];

          let content: string | null = null;
          for (const path of candidates) {
            content = await fetchRawFile(repo.slug, repo.branch, path);
            if (content) break;
          }

          if (!content) {
            cached = `No CHANGELOG.md found for ${pkg.name}.\n\nUse \`get_releases\` to see repo-level releases, or \`get_package_commits\` for recent changes.`;
          } else if (content.length > MAX_RESPONSE_LENGTH) {
            cached =
              content.slice(0, MAX_RESPONSE_LENGTH) +
              `\n\n---\n*[Content truncated at ${MAX_RESPONSE_LENGTH} characters. Use \`get_package_source\` with filePath "CHANGELOG.md" for full content.]*`;
          } else {
            cached = content;
          }
          changelogCache.set(cacheKey, cached);
        }

        return textResult(cached);
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  // Resource

  server.registerResource(
    "overview",
    "zk-kit://overview",
    {
      description: "High-level map of the ZK-Kit ecosystem: all packages grouped by language and category",
      mimeType: "text/markdown",
    },
    async (uri) => {
      try {
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: "text/markdown",
              text: registry.getEcosystemOverview(),
            },
          ],
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: "text/plain",
              text: `Error generating overview: ${msg}`,
            },
          ],
        };
      }
    },
  );

  // Resource Template: package

  const packageTemplate = new ResourceTemplate("zk-kit://packages/{language}/{dirName}", {
    list: async () => ({
      resources: registry.all.map((p) => ({
        uri: `zk-kit://packages/${p.language}/${p.dirName}`,
        name: p.name,
        description: p.description || undefined,
        mimeType: "text/markdown" as const,
      })),
    }),
    complete: {
      language: (value) =>
        [...new Set(registry.all.map((p) => p.language))].filter((l) => l.startsWith(value.toLowerCase())).sort(),
      dirName: (value, context) => {
        const lang = context?.arguments?.language;
        return registry.all
          .filter((p) => (!lang || p.language === lang) && p.dirName.startsWith(value))
          .map((p) => p.dirName)
          .filter((v, i, a) => a.indexOf(v) === i)
          .slice(0, 20);
      },
    },
  });

  server.registerResource(
    "package",
    packageTemplate,
    {
      description: "ZK-Kit package metadata and documentation",
      mimeType: "text/markdown",
    },
    async (uri, variables) => {
      try {
        const { language: lang, dirName } = variables;
        const pkg = registry.all.find((p) => p.language === lang && p.dirName === dirName);

        if (!pkg) {
          return {
            contents: [
              {
                uri: uri.href,
                mimeType: "text/plain",
                text: `Package not found: ${lang}/${dirName}`,
              },
            ],
          };
        }

        let text = `# ${pkg.name}\n\n`;
        text += `| Field | Value |\n|-------|-------|\n`;
        text += `| Language | ${pkg.language} |\n`;
        text += `| Category | ${pkg.category} |\n`;
        if (pkg.version) text += `| Version | ${pkg.version} |\n`;
        text += `| Install | \`${pkg.installCommand}\` |\n`;
        text += `| Repo | ${pkg.repo} |\n`;
        text += `| Cross-lang ID | ${pkg.crossLanguageId} |\n`;
        text += `\n${pkg.description || "(no description)"}\n`;

        // Fetch README
        const readme = await getOrFetchReadme(pkg);
        if (readme) {
          text += `\n---\n\n${readme}`;
        }

        return {
          contents: [
            {
              uri: uri.href,
              mimeType: "text/markdown",
              text,
            },
          ],
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: "text/plain",
              text: `Error: ${msg}`,
            },
          ],
        };
      }
    },
  );

  // Prompts

  server.registerPrompt(
    "zk-integration-guide",
    {
      description: "Guided workflow for integrating a ZK-Kit package into your project",
      argsSchema: {
        packageName: completable(
          z.string().optional().describe("Package to integrate (optional, will suggest if omitted)"),
          completePackageName(registry),
        ),
        language: Language.optional().describe("Target language"),
      },
    },
    async ({ packageName, language }) => {
      let intro: string;

      if (packageName) {
        let pkg = registry.getByName(packageName);
        if (pkg && language && pkg.language !== language) {
          const variant = registry.search(undefined, language).find((p) => p.crossLanguageId === pkg!.crossLanguageId);
          if (variant) pkg = variant;
        }
        if (pkg && language && pkg.language !== language) {
          const availableLangs = registry.all
            .filter((p) => p.crossLanguageId === pkg!.crossLanguageId)
            .map((p) => p.language);
          intro = `**${pkg.name}** is not available in ${language}. Available in: ${availableLangs.join(", ")}.\n\nUse \`list_packages\` with language="${language}" to see all ${language} packages.`;
        } else if (pkg) {
          intro = `You want to integrate **${pkg.name}** (${pkg.language}, ${pkg.category}).\n\nInstall: \`${pkg.installCommand}\`\n\nI'll fetch the README for detailed docs. Use \`get_package_readme\` with name "${pkg.name}" to see full API documentation and examples.`;
        } else {
          intro = `Package "${packageName}" not found. Use \`list_packages\` to browse available packages.`;
        }
      } else {
        const langFilter = language ? ` for ${language}` : "";
        intro = `Let's find the right ZK-Kit package${langFilter}. Here's what's available:\n\nUse \`list_packages\`${language ? ` with language="${language}"` : ""} to browse, or describe what you're building and I'll recommend packages.`;
      }

      return {
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: `I want to integrate a ZK-Kit package${packageName ? `: ${packageName}` : ""}.`,
            },
          },
          {
            role: "assistant" as const,
            content: { type: "text" as const, text: intro },
          },
        ],
      };
    },
  );

  server.registerPrompt(
    "zk-concept-explainer",
    {
      description:
        "Learn about a zero-knowledge concept through ZK-Kit implementations. Maps concepts like Merkle trees, Poseidon hash, EdDSA, etc. to concrete packages and source code.",
      argsSchema: {
        concept: z
          .string()
          .describe("ZK concept to explain (e.g., 'merkle tree', 'poseidon hash', 'eddsa', 'semaphore', 'ecdh')"),
        language: Language.optional().describe("Preferred language for examples"),
      },
    },
    async ({ concept, language }) => {
      const conceptLower = concept.toLowerCase();
      const related = registry.search(concept, language);
      const byCategory = registry.search(undefined, language, undefined).filter((p) => {
        const descLower = p.description.toLowerCase();
        return descLower.includes(conceptLower) || p.dirName.includes(conceptLower);
      });

      const seen = new Set<string>();
      const packages = [...related, ...byCategory]
        .filter((p) => {
          if (seen.has(p.name)) return false;
          seen.add(p.name);
          return true;
        })
        .slice(0, 10);

      let guide: string;
      if (packages.length === 0) {
        guide = `I couldn't find ZK-Kit packages directly related to "${concept}". This concept may not be implemented in ZK-Kit, or try a different search term.\n\nUse \`list_packages\` to browse all available packages, or \`search_code\` with query "${concept}" to search across all source code.`;
      } else {
        const langNote = language ? ` (filtered to ${language})` : "";
        guide = `# ${concept}${langNote}\n\nHere are the ZK-Kit packages related to this concept:\n\n`;
        for (const p of packages) {
          const ver = p.version ? ` v${p.version}` : "";
          guide += `## ${p.name}${ver} (${p.language})\n`;
          guide += `${p.description || "(no description)"}\n`;
          guide += `- Install: \`${p.installCommand}\`\n`;
          guide += `- Source: \`get_package_source\` with name "${p.name}"\n`;
          guide += `- Docs: \`get_package_readme\` with name "${p.name}"\n\n`;
        }

        const crossIds = [...new Set(packages.map((p) => p.crossLanguageId))];
        const allVariants = registry.all.filter((p) => crossIds.includes(p.crossLanguageId));
        const variantLangs = [...new Set(allVariants.map((p) => p.language))];
        if (variantLangs.length > 1) {
          guide += `## Available Languages\n\nThis concept is implemented in: ${variantLangs.join(", ")}.\n`;
        }

        guide += `\n## Next Steps\n\n`;
        guide += `1. Read the documentation: \`get_package_readme\` for any package above\n`;
        guide += `2. Browse the source: \`get_package_source\` to see the implementation\n`;
        guide += `3. Search for usage patterns: \`search_code\` with query "${concept}"\n`;
        guide += `4. Check dependencies: \`get_package_dependencies\` for integration requirements\n`;
      }

      return {
        messages: [
          {
            role: "user" as const,
            content: { type: "text" as const, text: `Explain the concept of "${concept}" in the context of ZK-Kit.` },
          },
          {
            role: "assistant" as const,
            content: { type: "text" as const, text: guide },
          },
        ],
      };
    },
  );

  server.registerPrompt(
    "troubleshoot-package",
    {
      description: "Guided troubleshooting workflow for issues with a ZK-Kit package",
      argsSchema: {
        packageName: completable(
          z.string().describe("Package you're having trouble with"),
          completePackageName(registry),
        ),
        errorMessage: z.string().optional().describe("Error message or description of the issue"),
        language: Language.optional().describe("Target language (helps find the right variant)"),
      },
    },
    async ({ packageName, errorMessage, language }) => {
      let pkg = registry.getByName(packageName);

      if (pkg && language && pkg.language !== language) {
        const variant = registry.search(undefined, language).find((p) => p.crossLanguageId === pkg!.crossLanguageId);
        if (variant) pkg = variant;
      }

      if (!pkg) {
        const suggestions = registry.suggest(packageName);
        const suggestText = suggestions.length
          ? `\n\nDid you mean:\n${suggestions.map((s) => `- ${s.name} (${s.language})`).join("\n")}`
          : "";
        return {
          messages: [
            {
              role: "user" as const,
              content: {
                type: "text" as const,
                text: `I'm having trouble with ${packageName}${errorMessage ? `: ${errorMessage}` : ""}.`,
              },
            },
            {
              role: "assistant" as const,
              content: {
                type: "text" as const,
                text: `Package "${packageName}" not found in the ZK-Kit ecosystem.${suggestText}\n\nUse \`list_packages\` to see all available packages.`,
              },
            },
          ],
        };
      }

      const errorDesc = errorMessage ? `: ${errorMessage}` : "";
      const errorKeywords = errorMessage
        ? errorMessage
            .replace(/[^a-zA-Z0-9\s-]/g, "")
            .split(/\s+/)
            .slice(0, 3)
            .join(" ")
        : pkg.dirName;
      const versionNote = pkg.version ? ` (current version: v${pkg.version})` : "";

      const variants = registry.all.filter((p) => p.crossLanguageId === pkg!.crossLanguageId && p.name !== pkg!.name);
      const variantSection =
        variants.length > 0
          ? `\n\n## Cross-Language Variants\n\nThis package is also available in other languages:\n${variants.map((v) => `- **${v.name}** (${v.language}): \`${v.installCommand}\``).join("\n")}\n\nIf the issue is language-specific, consider trying a different implementation.`
          : "";

      const guide = `# Troubleshooting: ${pkg.name}${versionNote}

## Step 1: Check Documentation
Use \`get_package_readme\` with name "${pkg.name}" to review the full API docs, usage examples, and known limitations.

## Step 2: Verify Installation
Make sure the package is correctly installed:
\`${pkg.installCommand}\`

## Step 3: Check Dependencies
Use \`get_package_dependencies\` with name "${pkg.name}" to verify all required dependencies are installed.

## Step 4: Search Known Issues
Use \`search_issues\` with query "${errorKeywords}" to find related bug reports and discussions.

## Step 5: Check for Updates
Use \`get_releases\` with language "${pkg.language}" to see if a newer version fixes your issue.${variantSection}`;

      return {
        messages: [
          {
            role: "user" as const,
            content: { type: "text" as const, text: `I'm having trouble with ${pkg.name}${errorDesc}.` },
          },
          {
            role: "assistant" as const,
            content: { type: "text" as const, text: guide },
          },
        ],
      };
    },
  );

  server.registerPrompt(
    "migration-guide",
    {
      description:
        "Guided workflow for migrating a ZK-Kit package - upgrading to a newer version or switching to a different language implementation",
      argsSchema: {
        packageName: completable(z.string().describe("Current package name"), completePackageName(registry)),
        targetLanguage: Language.optional().describe("Target language to migrate to (omit for version upgrade guide)"),
      },
    },
    async ({ packageName, targetLanguage }) => {
      const pkg = registry.getByName(packageName);

      if (!pkg) {
        const suggestions = registry.suggest(packageName);
        const suggestText = suggestions.length
          ? `\n\nDid you mean:\n${suggestions.map((s) => `- ${s.name} (${s.language})`).join("\n")}`
          : "";
        return {
          messages: [
            {
              role: "user" as const,
              content: {
                type: "text" as const,
                text: `I want to migrate ${packageName}${targetLanguage ? ` to ${targetLanguage}` : ""}.`,
              },
            },
            {
              role: "assistant" as const,
              content: {
                type: "text" as const,
                text: `Package "${packageName}" not found in the ZK-Kit ecosystem.${suggestText}\n\nUse \`list_packages\` to see all available packages.`,
              },
            },
          ],
        };
      }

      let guide: string;

      if (targetLanguage && targetLanguage !== pkg.language) {
        const targetPkg = registry.all.find(
          (p) => p.crossLanguageId === pkg!.crossLanguageId && p.language === targetLanguage,
        );

        if (!targetPkg) {
          const variants = registry.all.filter((p) => p.crossLanguageId === pkg!.crossLanguageId);
          guide = `**${pkg.name}** does not have a ${targetLanguage} implementation.\n\nAvailable implementations:\n`;
          for (const v of variants) {
            const ver = v.version ? ` v${v.version}` : "";
            guide += `- **${v.name}**${ver} (${v.language})\n`;
          }
          guide += `\nUse \`list_packages\` with language="${targetLanguage}" to find alternative ${targetLanguage} packages.`;
        } else {
          const fromVer = pkg.version ? ` v${pkg.version}` : "";
          const toVer = targetPkg.version ? ` v${targetPkg.version}` : "";
          guide = `# Migration: ${pkg.name} -> ${targetPkg.name}\n\n`;
          guide += `**From:** ${pkg.name}${fromVer} (${pkg.language})\n`;
          guide += `**To:** ${targetPkg.name}${toVer} (${targetPkg.language})\n\n`;
          guide += `## Step 1: Understand the Target\n`;
          guide += `Use \`get_package_readme\` with name "${targetPkg.name}" to read the API documentation.\n\n`;
          guide += `## Step 2: Compare Implementations\n`;
          guide += `Use \`compare_packages\` with names ["${pkg.name}", "${targetPkg.name}"] to see differences.\n`;
          guide += `Use \`get_package_source\` to browse both implementations side by side.\n\n`;
          guide += `## Step 3: Install New Package\n`;
          guide += `\`${targetPkg.installCommand}\`\n\n`;
          guide += `## Step 4: Check Dependencies\n`;
          guide += `Use \`get_package_dependencies\` with name "${targetPkg.name}" to verify required dependencies.\n\n`;
          guide += `## Step 5: Remove Old Package\n`;
          guide += `Uninstall ${pkg.name} after migration is complete and all references are updated.\n`;
        }
      } else {
        const ver = pkg.version ? ` v${pkg.version}` : "";
        guide = `# Upgrade Guide: ${pkg.name}${ver}\n\n`;
        guide += `## Step 1: Check Current Version\n`;
        guide += `You're using **${pkg.name}**${ver}.\n\n`;
        guide += `## Step 2: Review Recent Releases\n`;
        guide += `Use \`get_releases\` with language "${pkg.language}" to see what's new and check for breaking changes.\n\n`;
        guide += `## Step 3: Check Recent Commits\n`;
        guide += `Use \`get_package_commits\` with name "${pkg.name}" to see what changed recently.\n\n`;
        guide += `## Step 4: Review Documentation\n`;
        guide += `Use \`get_package_readme\` with name "${pkg.name}" for updated API documentation.\n\n`;
        guide += `## Step 5: Check Dependencies\n`;
        guide += `Use \`get_package_dependencies\` with name "${pkg.name}" to verify compatible dependencies.\n\n`;
        guide += `## Step 6: Update\n`;
        guide += `\`${pkg.installCommand}\`\n`;

        const variants = registry.all.filter((p) => p.crossLanguageId === pkg!.crossLanguageId && p.name !== pkg!.name);
        if (variants.length > 0) {
          guide += `\n## Alternative: Switch Language\n\n`;
          guide += `This package is also available in:\n`;
          for (const v of variants) {
            const vver = v.version ? ` v${v.version}` : "";
            guide += `- **${v.name}**${vver} (${v.language}): \`${v.installCommand}\`\n`;
          }
          guide += `\nTo migrate to a different language, use this prompt again with a \`targetLanguage\`.`;
        }
      }

      return {
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: targetLanguage
                ? `I want to migrate ${pkg.name} from ${pkg.language} to ${targetLanguage}.`
                : `I want to upgrade ${pkg.name} to the latest version.`,
            },
          },
          {
            role: "assistant" as const,
            content: { type: "text" as const, text: guide },
          },
        ],
      };
    },
  );

  function clearCaches(): void {
    readmeCache.clear();
    releaseCache.clear();
    depsCache.clear();
    statsCache.clear();
    treeCache.clear();
    codeSearchCache.clear();
    commitsCache.clear();
    downloadsCache.clear();
    buildStatusCache.clear();
    issueSearchCache.clear();
    changelogCache.clear();
  }

  return { server, clearCaches };
}

// Main

async function main(): Promise<void> {
  const startTime = Date.now();
  logger.info("server", "Discovering packages from GitHub...");
  const packages = await discoverAllPackages();
  if (packages.length === 0) {
    logger.warn("server", "No packages discovered. Server will start with empty registry.");
  }
  const registry = new PackageRegistry();
  registry.load(packages);
  logger.info("server", `Loaded ${registry.count} packages`, { durationMs: Date.now() - startTime });

  const { server } = createServer(registry);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("server", "Connected via STDIO");
}

const scriptPath = resolve(realpathSync(process.argv[1] ?? ""));
const modulePath = fileURLToPath(import.meta.url);
const isEntryPoint = scriptPath === modulePath;
if (isEntryPoint) {
  main().catch((err) => {
    logger.error("server", "Fatal error", { error: String(err) });
    process.exit(1);
  });
}
