import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer } from "../src/index.js";
import { PackageRegistry } from "../src/registry.js";
import type { Package } from "../src/types.js";

// Mock github.js to avoid network calls
vi.mock("../src/github.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/github.js")>();
  return {
    ...actual,
    fetchReadme: vi.fn(),
    fetchReleases: vi.fn(),
    searchIssues: vi.fn(),
    fetchPackageDependencies: vi.fn(),
    fetchRepoStats: vi.fn(),
    fetchDirectoryTree: vi.fn(),
    fetchRawFile: vi.fn(),
    searchCode: vi.fn(),
    fetchPackageCommits: vi.fn(),
    fetchPackageDownloads: vi.fn(),
    fetchWorkflowRuns: vi.fn(),
  };
});

// Mock discovery to prevent any accidental real API calls from main()
vi.mock("../src/discovery.js", () => ({
  discoverAllPackages: vi.fn().mockResolvedValue([]),
}));

import {
  fetchDirectoryTree,
  fetchPackageCommits,
  fetchPackageDependencies,
  fetchPackageDownloads,
  fetchRawFile,
  fetchReadme,
  fetchReleases,
  fetchRepoStats,
  fetchWorkflowRuns,
  searchCode,
  searchIssues,
} from "../src/github.js";

const mockFetchReadme = vi.mocked(fetchReadme);
const mockFetchReleases = vi.mocked(fetchReleases);
const mockSearchIssues = vi.mocked(searchIssues);
const mockFetchDeps = vi.mocked(fetchPackageDependencies);
const mockFetchRepoStats = vi.mocked(fetchRepoStats);
const mockFetchDirTree = vi.mocked(fetchDirectoryTree);
const mockFetchRawFile = vi.mocked(fetchRawFile);
const mockSearchCode = vi.mocked(searchCode);
const mockFetchCommits = vi.mocked(fetchPackageCommits);
const mockFetchDownloads = vi.mocked(fetchPackageDownloads);
const mockFetchWorkflowRuns = vi.mocked(fetchWorkflowRuns);

function makePackage(overrides: Partial<Package> = {}): Package {
  return {
    name: "@zk-kit/lean-imt",
    dirName: "lean-imt",
    language: "typescript",
    category: "merkle-trees",
    repo: "https://github.com/zk-kit/zk-kit/tree/main/packages/lean-imt",
    description: "Lean Incremental Merkle Tree implementation",
    installCommand: "npm i @zk-kit/lean-imt",
    crossLanguageId: "lean-imt",
    zkKitDependencies: [],
    ...overrides,
  };
}

const TEST_PACKAGES: Package[] = [
  makePackage({ version: "1.2.3" }),
  makePackage({
    name: "@zk-kit/poseidon-lite",
    dirName: "poseidon-lite",
    category: "cryptography",
    description: "Lightweight Poseidon hash",
    installCommand: "npm i @zk-kit/poseidon-lite",
    crossLanguageId: "poseidon-lite",
    version: "0.5.0",
  }),
  makePackage({
    name: "@zk-kit/lean-imt.sol",
    dirName: "lean-imt",
    language: "solidity",
    description: "Lean IMT in Solidity",
    installCommand: "npm i @zk-kit/lean-imt.sol",
    crossLanguageId: "lean-imt",
  }),
  makePackage({
    name: "@zk-kit/ecdh",
    dirName: "ecdh",
    category: "cryptography",
    description: "ECDH shared secret derivation",
    installCommand: "npm i @zk-kit/ecdh",
    crossLanguageId: "ecdh",
    version: "0.3.0",
  }),
  makePackage({
    name: "zk-kit-baby-jubjub",
    dirName: "baby-jubjub",
    language: "rust",
    category: "cryptography",
    description: "Baby JubJub elliptic curve",
    installCommand: "cargo add zk-kit-baby-jubjub",
    crossLanguageId: "baby-jubjub",
    version: "0.1.0",
  }),
];

let client: Client;
let clientTransport: InMemoryTransport;
let serverTransport: InMemoryTransport;
let clearCaches: () => void;

beforeAll(async () => {
  const registry = new PackageRegistry();
  registry.load(TEST_PACKAGES);
  const created = createServer(registry);
  clearCaches = created.clearCaches;

  [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await created.server.connect(serverTransport);
  client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(clientTransport);
});

beforeEach(() => {
  clearCaches();
});

afterAll(async () => {
  await clientTransport.close();
  await serverTransport.close();
});

function textOf(result: Awaited<ReturnType<typeof client.callTool>>): string {
  const content = result.content as { type: string; text: string }[];
  return content.map((c) => c.text).join("\n");
}

describe("MCP introspection", () => {
  it("lists all 17 tools with correct names", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "compare_packages",
      "get_build_status",
      "get_cross_language_coverage",
      "get_dependency_graph",
      "get_ecosystem_overview",
      "get_package_api",
      "get_package_changelog",
      "get_package_commits",
      "get_package_dependencies",
      "get_package_downloads",
      "get_package_readme",
      "get_package_source",
      "get_releases",
      "get_repo_stats",
      "list_packages",
      "search_code",
      "search_issues",
    ]);
  });

  it("all tools have readOnlyHint and idempotentHint annotations", async () => {
    const { tools } = await client.listTools();
    for (const tool of tools) {
      expect(tool.annotations?.readOnlyHint).toBe(true);
      expect(tool.annotations?.idempotentHint).toBe(true);
    }
  });

  it("registry-only tools have openWorldHint=false, others true", async () => {
    const { tools } = await client.listTools();
    const registryOnly = [
      "list_packages",
      "get_ecosystem_overview",
      "compare_packages",
      "get_cross_language_coverage",
      "get_dependency_graph",
    ];
    for (const tool of tools) {
      if (registryOnly.includes(tool.name)) {
        expect(tool.annotations?.openWorldHint, `${tool.name} should be openWorldHint=false`).toBe(false);
      } else {
        expect(tool.annotations?.openWorldHint, `${tool.name} should be openWorldHint=true`).toBe(true);
      }
    }
  });

  it("lists the overview resource and package resources", async () => {
    const { resources } = await client.listResources();
    // Static overview + 4 packages from the template's list callback
    expect(resources.length).toBe(1 + TEST_PACKAGES.length);
    const overview = resources.find((r) => r.uri === "zk-kit://overview");
    expect(overview).toBeDefined();
    expect(overview!.mimeType).toBe("text/markdown");
    // Package resources from template
    const pkgResources = resources.filter((r) => r.uri.startsWith("zk-kit://packages/"));
    expect(pkgResources).toHaveLength(TEST_PACKAGES.length);
  });

  it("lists the resource template", async () => {
    const { resourceTemplates } = await client.listResourceTemplates();
    expect(resourceTemplates).toHaveLength(1);
    expect(resourceTemplates[0].uriTemplate).toBe("zk-kit://packages/{language}/{dirName}");
  });

  it("lists all 4 prompts", async () => {
    const { prompts } = await client.listPrompts();
    expect(prompts).toHaveLength(4);
    const names = prompts.map((p) => p.name).sort();
    expect(names).toEqual(["migration-guide", "troubleshoot-package", "zk-concept-explainer", "zk-integration-guide"]);
  });
});

describe("list_packages", () => {
  it("returns all packages with no filters", async () => {
    const result = await client.callTool({ name: "list_packages", arguments: {} });
    const text = textOf(result);
    expect(text).toContain("@zk-kit/lean-imt");
    expect(text).toContain("@zk-kit/poseidon-lite");
    expect(text).toContain("@zk-kit/lean-imt.sol");
  });

  it("filters by language", async () => {
    const result = await client.callTool({
      name: "list_packages",
      arguments: { language: "solidity" },
    });
    const text = textOf(result);
    expect(text).toContain("@zk-kit/lean-imt.sol");
    expect(text).not.toContain("poseidon-lite");
  });

  it("filters by category", async () => {
    const result = await client.callTool({
      name: "list_packages",
      arguments: { category: "cryptography" },
    });
    const text = textOf(result);
    expect(text).toContain("poseidon-lite");
    expect(text).not.toContain("lean-imt.sol");
  });

  it("returns message when no packages match", async () => {
    const result = await client.callTool({
      name: "list_packages",
      arguments: { query: "nonexistent-xyz-abc" },
    });
    const text = textOf(result);
    expect(text).toContain("No packages found");
  });

  it("supports multi-word search", async () => {
    const result = await client.callTool({
      name: "list_packages",
      arguments: { query: "lean merkle" },
    });
    const text = textOf(result);
    expect(text).toContain("@zk-kit/lean-imt");
    expect(text).not.toContain("poseidon-lite");
  });
});

describe("get_package_readme", () => {
  it("returns suggestions when package not found", async () => {
    const result = await client.callTool({
      name: "get_package_readme",
      arguments: { name: "lean" },
    });
    const text = textOf(result);
    expect(text).toContain("not found");
    expect(text).toContain("Did you mean");
  });

  it("returns no-suggestions message for completely unknown package", async () => {
    const result = await client.callTool({
      name: "get_package_readme",
      arguments: { name: "zzzzz-unknown" },
    });
    const text = textOf(result);
    expect(text).toContain("not found");
    expect(text).toContain("list_packages");
  });

  it("fetches README for known package", async () => {
    mockFetchReadme.mockResolvedValueOnce("# Lean IMT\n\nA lean incremental Merkle tree.");
    const result = await client.callTool({
      name: "get_package_readme",
      arguments: { name: "@zk-kit/lean-imt" },
    });
    const text = textOf(result);
    expect(text).toContain("# Lean IMT");
  });

  it("returns metadata fallback when README fetch fails", async () => {
    mockFetchReadme.mockResolvedValueOnce(null);
    const result = await client.callTool({
      name: "get_package_readme",
      arguments: { name: "@zk-kit/poseidon-lite" },
    });
    const text = textOf(result);
    expect(text).toContain("README could not be fetched");
    expect(text).toContain("@zk-kit/poseidon-lite");
  });
});

describe("get_ecosystem_overview", () => {
  it("returns overview with package count", async () => {
    const result = await client.callTool({ name: "get_ecosystem_overview", arguments: {} });
    const text = textOf(result);
    expect(text).toContain("ZK-Kit Ecosystem");
    expect(text).toContain(`${TEST_PACKAGES.length} packages`);
  });
});

describe("compare_packages", () => {
  it("returns markdown comparison table", async () => {
    const result = await client.callTool({
      name: "compare_packages",
      arguments: { names: ["@zk-kit/lean-imt", "@zk-kit/lean-imt.sol"] },
    });
    const text = textOf(result);
    expect(text).toContain("@zk-kit/lean-imt");
    expect(text).toContain("@zk-kit/lean-imt.sol");
    expect(text).toContain("Language");
    expect(text).toContain("typescript");
    expect(text).toContain("solidity");
  });

  it("handles not-found packages", async () => {
    const result = await client.callTool({
      name: "compare_packages",
      arguments: { names: ["@zk-kit/lean-imt", "nonexistent"] },
    });
    const text = textOf(result);
    expect(text).toContain("Not found");
    expect(text).toContain("nonexistent");
  });
});

describe("get_releases", () => {
  it("returns releases for a language", async () => {
    mockFetchReleases.mockResolvedValueOnce([
      {
        tag: "v1.0.0",
        name: "v1.0.0",
        date: "2024-01-15T00:00:00Z",
        url: "https://github.com/...",
        body: "First release",
      },
    ]);
    const result = await client.callTool({
      name: "get_releases",
      arguments: { language: "typescript" },
    });
    const text = textOf(result);
    expect(text).toContain("v1.0.0");
  });

  it("caches empty release results", async () => {
    const callsBefore = mockFetchReleases.mock.calls.length;
    mockFetchReleases.mockResolvedValueOnce([]);
    const result1 = await client.callTool({
      name: "get_releases",
      arguments: { repo: "zk-kit/zk-kit.noir" },
    });
    expect(textOf(result1)).toContain("No releases found");

    // Second call should use cache, NOT trigger another fetch
    const result2 = await client.callTool({
      name: "get_releases",
      arguments: { repo: "zk-kit/zk-kit.noir" },
    });
    expect(textOf(result2)).toContain("No releases found");
    expect(mockFetchReleases.mock.calls.length - callsBefore).toBe(1);
  });

  it("filters releases by package name", async () => {
    mockFetchReleases.mockResolvedValueOnce([
      {
        tag: "@zk-kit/lean-imt@1.0.0",
        name: "lean-imt v1.0.0",
        date: "2024-01-15T00:00:00Z",
        url: "https://github.com/...",
        body: "",
      },
    ]);
    const result = await client.callTool({
      name: "get_releases",
      arguments: { package: "@zk-kit/lean-imt" },
    });
    const text = textOf(result);
    expect(text).toContain("lean-imt");
    expect(mockFetchReleases).toHaveBeenCalledWith("zk-kit/zk-kit", 10, "@zk-kit/lean-imt");
  });

  it("returns suggestions for unknown package in release filter", async () => {
    const result = await client.callTool({
      name: "get_releases",
      arguments: { package: "lean" },
    });
    const text = textOf(result);
    expect(text).toContain("not found");
    expect(text).toContain("Did you mean");
  });

  it("defaults to all repos when no language or repo provided", async () => {
    for (let i = 0; i < 5; i++) {
      mockFetchReleases.mockResolvedValueOnce([]);
    }
    const result = await client.callTool({
      name: "get_releases",
      arguments: { limit: 3 },
    });
    const text = textOf(result);
    expect(text).toContain("No releases found");
  });
});

describe("search_issues", () => {
  it("returns issues matching query", async () => {
    mockSearchIssues.mockResolvedValueOnce([
      {
        number: 42,
        title: "Bug in lean-imt",
        state: "open",
        url: "https://github.com/...",
        labels: ["bug"],
        created: "2024-01-01T00:00:00Z",
      },
    ]);
    const result = await client.callTool({
      name: "search_issues",
      arguments: { query: "lean-imt bug" },
    });
    const text = textOf(result);
    expect(text).toContain("Bug in lean-imt");
    expect(text).toContain("#42");
  });

  it("returns message when no issues found", async () => {
    mockSearchIssues.mockResolvedValueOnce([]);
    const result = await client.callTool({
      name: "search_issues",
      arguments: { query: "nonexistent-issue-xyz" },
    });
    const text = textOf(result);
    expect(text).toContain("No issues found");
  });

  it("returns isError on failure", async () => {
    mockSearchIssues.mockRejectedValueOnce(new Error("GitHub API 500"));
    const result = await client.callTool({
      name: "search_issues",
      arguments: { query: "test" },
    });
    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain("Error");
  });

  it("caches results", async () => {
    const callsBefore = mockSearchIssues.mock.calls.length;
    mockSearchIssues.mockResolvedValueOnce([
      {
        number: 99,
        title: "Cache test issue",
        state: "open",
        url: "https://github.com/...",
        labels: [],
        created: "2024-01-01T00:00:00Z",
      },
    ]);
    await client.callTool({
      name: "search_issues",
      arguments: { query: "cache-test-unique-issue-query" },
    });
    await client.callTool({
      name: "search_issues",
      arguments: { query: "cache-test-unique-issue-query" },
    });
    expect(mockSearchIssues.mock.calls.length - callsBefore).toBe(1);
  });
});

describe("resource: zk-kit://overview", () => {
  it("returns ecosystem overview markdown", async () => {
    const result = await client.readResource({ uri: "zk-kit://overview" });
    const text = (result.contents[0] as { text: string }).text;
    expect(text).toContain("ZK-Kit Ecosystem");
    expect(text).toContain(`${TEST_PACKAGES.length} packages`);
    expect(result.contents[0].mimeType).toBe("text/markdown");
  });
});

describe("empty registry behavior", () => {
  let emptyClient: Client;
  let emptyClientTransport: InMemoryTransport;
  let emptyServerTransport: InMemoryTransport;

  beforeAll(async () => {
    const emptyRegistry = new PackageRegistry();
    emptyRegistry.load([]);
    const { server: emptyServer } = createServer(emptyRegistry);
    [emptyClientTransport, emptyServerTransport] = InMemoryTransport.createLinkedPair();
    await emptyServer.connect(emptyServerTransport);
    emptyClient = new Client({ name: "test-client-empty", version: "1.0.0" });
    await emptyClient.connect(emptyClientTransport);
  });

  afterAll(async () => {
    await emptyClientTransport.close();
    await emptyServerTransport.close();
  });

  it("list_packages hints at empty registry", async () => {
    const result = await emptyClient.callTool({ name: "list_packages", arguments: {} });
    const text = textOf(result);
    expect(text).toContain("registry is empty");
    expect(text).toContain("GITHUB_TOKEN");
  });

  it("get_package_readme hints at empty registry", async () => {
    const result = await emptyClient.callTool({ name: "get_package_readme", arguments: { name: "anything" } });
    const text = textOf(result);
    expect(text).toContain("registry is empty");
    expect(text).toContain("GITHUB_TOKEN");
  });

  it("get_ecosystem_overview hints at empty registry", async () => {
    const result = await emptyClient.callTool({ name: "get_ecosystem_overview", arguments: {} });
    const text = textOf(result);
    expect(text).toContain("registry is empty");
    expect(text).toContain("GITHUB_TOKEN");
  });

  it("compare_packages hints at empty registry", async () => {
    const result = await emptyClient.callTool({
      name: "compare_packages",
      arguments: { names: ["a", "b"] },
    });
    const text = textOf(result);
    expect(text).toContain("registry is empty");
    expect(text).toContain("GITHUB_TOKEN");
  });
});

describe("prompt: zk-integration-guide", () => {
  it("returns integration guide for known package", async () => {
    const result = await client.getPrompt({
      name: "zk-integration-guide",
      arguments: { packageName: "@zk-kit/lean-imt" },
    });
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0].role).toBe("user");
    const assistantText = (result.messages[1].content as { text: string }).text;
    expect(assistantText).toContain("@zk-kit/lean-imt");
    expect(assistantText).toContain("npm i @zk-kit/lean-imt");
  });

  it("returns not-found message for unknown package", async () => {
    const result = await client.getPrompt({
      name: "zk-integration-guide",
      arguments: { packageName: "nonexistent" },
    });
    const assistantText = (result.messages[1].content as { text: string }).text;
    expect(assistantText).toContain("not found");
  });

  it("returns browse suggestion when no package specified", async () => {
    const result = await client.getPrompt({
      name: "zk-integration-guide",
      arguments: {},
    });
    const assistantText = (result.messages[1].content as { text: string }).text;
    expect(assistantText).toContain("list_packages");
  });

  it("filters by language when specified", async () => {
    const result = await client.getPrompt({
      name: "zk-integration-guide",
      arguments: { language: "solidity" },
    });
    const assistantText = (result.messages[1].content as { text: string }).text;
    expect(assistantText).toContain("solidity");
  });

  it("uses language to find cross-language variant when both provided", async () => {
    const result = await client.getPrompt({
      name: "zk-integration-guide",
      arguments: { packageName: "lean-imt", language: "solidity" },
    });
    const assistantText = (result.messages[1].content as { text: string }).text;
    expect(assistantText).toContain("@zk-kit/lean-imt.sol");
    expect(assistantText).toContain("solidity");
  });

  it("shows available languages when variant doesn't exist", async () => {
    const result = await client.getPrompt({
      name: "zk-integration-guide",
      arguments: { packageName: "poseidon-lite", language: "solidity" },
    });
    const assistantText = (result.messages[1].content as { text: string }).text;
    expect(assistantText).toContain("not available in solidity");
    expect(assistantText).toContain("typescript");
  });
});

// Version in existing tools

describe("version enrichment", () => {
  it("shows version in list_packages output", async () => {
    const result = await client.callTool({ name: "list_packages", arguments: {} });
    const text = textOf(result);
    expect(text).toContain("v1.2.3");
    expect(text).toContain("v0.5.0");
  });

  it("shows version in readme fallback", async () => {
    mockFetchReadme.mockResolvedValueOnce(null);
    const result = await client.callTool({
      name: "get_package_readme",
      arguments: { name: "@zk-kit/lean-imt.sol" },
    });
    const text = textOf(result);
    // lean-imt.sol has no version, so test the fallback structure
    expect(text).toContain("README could not be fetched");
    expect(text).toContain("solidity");
  });

  it("shows version in compare table", async () => {
    const result = await client.callTool({
      name: "compare_packages",
      arguments: { names: ["@zk-kit/lean-imt", "@zk-kit/lean-imt.sol"] },
    });
    const text = textOf(result);
    expect(text).toContain("Version");
    expect(text).toContain("1.2.3");
  });
});

// get_package_dependencies

describe("get_package_dependencies", () => {
  it("returns deps for known package", async () => {
    mockFetchDeps.mockResolvedValueOnce({
      dependencies: { "poseidon-lite": "^0.2.0" },
      devDependencies: { vitest: "^1.0.0" },
      peerDependencies: {},
    });
    const result = await client.callTool({
      name: "get_package_dependencies",
      arguments: { name: "@zk-kit/lean-imt" },
    });
    const text = textOf(result);
    expect(text).toContain("poseidon-lite");
    expect(text).toContain("vitest");
    expect(text).toContain("Dependencies");
  });

  it("returns suggestions when package not found", async () => {
    const result = await client.callTool({
      name: "get_package_dependencies",
      arguments: { name: "lean" },
    });
    const text = textOf(result);
    expect(text).toContain("not found");
    expect(text).toContain("Did you mean");
  });

  it("handles null manifest", async () => {
    mockFetchDeps.mockResolvedValueOnce(null);
    const result = await client.callTool({
      name: "get_package_dependencies",
      arguments: { name: "@zk-kit/poseidon-lite" },
    });
    const text = textOf(result);
    expect(text).toContain("Could not fetch dependencies");
  });

  it("caches results", async () => {
    const callsBefore = mockFetchDeps.mock.calls.length;
    mockFetchDeps.mockResolvedValueOnce({
      dependencies: { a: "1.0" },
      devDependencies: {},
      peerDependencies: {},
    });
    await client.callTool({
      name: "get_package_dependencies",
      arguments: { name: "@zk-kit/lean-imt.sol" },
    });
    await client.callTool({
      name: "get_package_dependencies",
      arguments: { name: "@zk-kit/lean-imt.sol" },
    });
    expect(mockFetchDeps.mock.calls.length - callsBefore).toBe(1);
  });

  it("returns isError on failure", async () => {
    mockFetchDeps.mockRejectedValueOnce(new Error("Network error"));
    const result = await client.callTool({
      name: "get_package_dependencies",
      arguments: { name: "@zk-kit/ecdh" },
    });
    expect(result.isError).toBe(true);
  });
});

// get_repo_stats

describe("get_repo_stats", () => {
  it("returns stats for a specific repo", async () => {
    mockFetchRepoStats.mockResolvedValueOnce({
      slug: "zk-kit/zk-kit.solidity",
      description: "Solidity ZK toolkit",
      stars: 500,
      forks: 100,
      openIssues: 10,
      lastPushed: "2024-06-15T00:00:00Z",
      license: "MIT",
      topics: ["zk", "crypto"],
      language: "Solidity",
      url: "https://github.com/zk-kit/zk-kit.solidity",
    });
    const result = await client.callTool({
      name: "get_repo_stats",
      arguments: { repo: "zk-kit/zk-kit.solidity" },
    });
    const text = textOf(result);
    expect(text).toContain("500");
    expect(text).toContain("MIT");
    expect(text).toContain("zk-kit.solidity");
  });

  it("returns stats for a language", async () => {
    mockFetchRepoStats.mockResolvedValueOnce({
      slug: "zk-kit/zk-kit",
      description: "TypeScript ZK toolkit",
      stars: 500,
      forks: 100,
      openIssues: 10,
      lastPushed: "2024-06-15T00:00:00Z",
      license: "MIT",
      topics: ["zk", "crypto"],
      language: "TypeScript",
      url: "https://github.com/zk-kit/zk-kit",
    });
    const result = await client.callTool({
      name: "get_repo_stats",
      arguments: { language: "typescript" },
    });
    const text = textOf(result);
    expect(text).toContain("500");
    expect(text).toContain("zk-kit/zk-kit");
  });

  it("caches results", async () => {
    const callsBefore = mockFetchRepoStats.mock.calls.length;
    mockFetchRepoStats.mockResolvedValueOnce({
      slug: "zk-kit/zk-kit",
      description: "TypeScript ZK toolkit",
      stars: 500,
      forks: 100,
      openIssues: 10,
      lastPushed: "2024-06-15T00:00:00Z",
      license: "MIT",
      topics: [],
      language: "TypeScript",
      url: "https://github.com/zk-kit/zk-kit",
    });
    await client.callTool({ name: "get_repo_stats", arguments: { language: "typescript" } });
    // Second call should use cache
    await client.callTool({ name: "get_repo_stats", arguments: { language: "typescript" } });
    expect(mockFetchRepoStats.mock.calls.length - callsBefore).toBe(1);
  });

  it("returns isError on failure", async () => {
    mockFetchRepoStats.mockRejectedValueOnce(new Error("API error"));
    const result = await client.callTool({
      name: "get_repo_stats",
      arguments: { repo: "zk-kit/zk-kit.rust" },
    });
    expect(result.isError).toBe(true);
  });
});

// get_package_source

describe("get_package_source", () => {
  it("returns directory tree when no filePath", async () => {
    mockFetchDirTree.mockResolvedValueOnce([
      { name: "src", path: "src", type: "dir" },
      { name: "index.ts", path: "src/index.ts", type: "file", size: 1024 },
      { name: "package.json", path: "package.json", type: "file", size: 200 },
    ]);
    const result = await client.callTool({
      name: "get_package_source",
      arguments: { name: "@zk-kit/lean-imt" },
    });
    const text = textOf(result);
    expect(text).toContain("File Tree");
    expect(text).toContain("src/");
    expect(text).toContain("index.ts");
    expect(text).toContain("package.json");
  });

  it("returns file content with filePath", async () => {
    mockFetchRawFile.mockResolvedValueOnce("export function leanIMT() { return 42; }");
    const result = await client.callTool({
      name: "get_package_source",
      arguments: { name: "@zk-kit/lean-imt", filePath: "src/index.ts" },
    });
    const text = textOf(result);
    expect(text).toContain("```typescript");
    expect(text).toContain("leanIMT");
  });

  it("returns file-not-found hint", async () => {
    mockFetchRawFile.mockResolvedValueOnce(null);
    const result = await client.callTool({
      name: "get_package_source",
      arguments: { name: "@zk-kit/lean-imt", filePath: "nonexistent.ts" },
    });
    const text = textOf(result);
    expect(text).toContain("File not found");
    expect(text).toContain("directory tree");
  });

  it("returns suggestions for unknown package", async () => {
    const result = await client.callTool({
      name: "get_package_source",
      arguments: { name: "lean" },
    });
    const text = textOf(result);
    expect(text).toContain("not found");
    expect(text).toContain("Did you mean");
  });

  it("caches tree results", async () => {
    const callsBefore = mockFetchDirTree.mock.calls.length;
    mockFetchDirTree.mockResolvedValueOnce([{ name: "lib.rs", path: "lib.rs", type: "file", size: 500 }]);
    await client.callTool({
      name: "get_package_source",
      arguments: { name: "@zk-kit/lean-imt.sol" },
    });
    await client.callTool({
      name: "get_package_source",
      arguments: { name: "@zk-kit/lean-imt.sol" },
    });
    expect(mockFetchDirTree.mock.calls.length - callsBefore).toBe(1);
  });

  it("detects correct code block language", async () => {
    mockFetchRawFile.mockResolvedValueOnce("pragma solidity ^0.8.0;");
    const result = await client.callTool({
      name: "get_package_source",
      arguments: { name: "@zk-kit/lean-imt.sol", filePath: "contracts/LeanIMT.sol" },
    });
    const text = textOf(result);
    expect(text).toContain("```solidity");
  });

  it("returns isError on failure", async () => {
    mockFetchDirTree.mockRejectedValueOnce(new Error("API error"));
    const result = await client.callTool({
      name: "get_package_source",
      arguments: { name: "@zk-kit/poseidon-lite" },
    });
    expect(result.isError).toBe(true);
  });
});

// troubleshoot-package prompt

describe("prompt: troubleshoot-package", () => {
  it("returns troubleshooting guide for known package", async () => {
    const result = await client.getPrompt({
      name: "troubleshoot-package",
      arguments: { packageName: "@zk-kit/lean-imt" },
    });
    expect(result.messages).toHaveLength(2);
    const assistantText = (result.messages[1].content as { text: string }).text;
    expect(assistantText).toContain("Troubleshooting");
    expect(assistantText).toContain("@zk-kit/lean-imt");
    expect(assistantText).toContain("Step 1");
    expect(assistantText).toContain("Step 5");
  });

  it("includes error message in user text", async () => {
    const result = await client.getPrompt({
      name: "troubleshoot-package",
      arguments: {
        packageName: "@zk-kit/lean-imt",
        errorMessage: "Cannot find module",
      },
    });
    const userText = (result.messages[0].content as { text: string }).text;
    expect(userText).toContain("Cannot find module");
  });

  it("uses error keywords in search suggestion", async () => {
    const result = await client.getPrompt({
      name: "troubleshoot-package",
      arguments: {
        packageName: "@zk-kit/lean-imt",
        errorMessage: "tree depth overflow error",
      },
    });
    const assistantText = (result.messages[1].content as { text: string }).text;
    expect(assistantText).toContain("tree depth overflow");
  });

  it("returns not-found with suggestions", async () => {
    const result = await client.getPrompt({
      name: "troubleshoot-package",
      arguments: { packageName: "lean" },
    });
    const assistantText = (result.messages[1].content as { text: string }).text;
    expect(assistantText).toContain("not found");
    expect(assistantText).toContain("Did you mean");
  });

  it("shows cross-language variants", async () => {
    const result = await client.getPrompt({
      name: "troubleshoot-package",
      arguments: { packageName: "@zk-kit/lean-imt" },
    });
    const assistantText = (result.messages[1].content as { text: string }).text;
    expect(assistantText).toContain("Cross-Language Variants");
    expect(assistantText).toContain("@zk-kit/lean-imt.sol");
  });

  it("resolves language variant", async () => {
    const result = await client.getPrompt({
      name: "troubleshoot-package",
      arguments: { packageName: "lean-imt", language: "solidity" },
    });
    const assistantText = (result.messages[1].content as { text: string }).text;
    expect(assistantText).toContain("@zk-kit/lean-imt.sol");
  });

  it("displays version when available", async () => {
    const result = await client.getPrompt({
      name: "troubleshoot-package",
      arguments: { packageName: "@zk-kit/lean-imt" },
    });
    const assistantText = (result.messages[1].content as { text: string }).text;
    expect(assistantText).toContain("v1.2.3");
  });
});

// --- search_code ---

describe("search_code", () => {
  it("returns code search results", async () => {
    mockSearchCode.mockResolvedValueOnce([
      {
        path: "packages/lean-imt/src/lean-imt.ts",
        repo: "zk-kit/zk-kit",
        url: "https://github.com/zk-kit/zk-kit/blob/main/packages/lean-imt/src/lean-imt.ts",
        fragment: "export function insert(tree: LeanIMT, leaf: bigint)",
      },
    ]);
    const result = await client.callTool({
      name: "search_code",
      arguments: { query: "function insert" },
    });
    const text = textOf(result);
    expect(text).toContain("lean-imt.ts");
    expect(text).toContain("function insert");
    expect(text).toContain("zk-kit/zk-kit");
  });

  it("returns no-matches message", async () => {
    mockSearchCode.mockResolvedValueOnce([]);
    const result = await client.callTool({
      name: "search_code",
      arguments: { query: "xyznonexistent123" },
    });
    const text = textOf(result);
    expect(text).toContain("No code matches found");
  });

  it("passes language filter", async () => {
    mockSearchCode.mockResolvedValueOnce([]);
    await client.callTool({
      name: "search_code",
      arguments: { query: "poseidon", language: "solidity" },
    });
    expect(mockSearchCode).toHaveBeenCalledWith("poseidon", "solidity", undefined, undefined);
  });

  it("caches results", async () => {
    const callsBefore = mockSearchCode.mock.calls.length;
    mockSearchCode.mockResolvedValueOnce([
      { path: "test.ts", repo: "zk-kit/zk-kit", url: "https://example.com", fragment: "test" },
    ]);
    await client.callTool({
      name: "search_code",
      arguments: { query: "cache-test-query-unique" },
    });
    await client.callTool({
      name: "search_code",
      arguments: { query: "cache-test-query-unique" },
    });
    expect(mockSearchCode.mock.calls.length - callsBefore).toBe(1);
  });

  it("returns isError on failure", async () => {
    mockSearchCode.mockRejectedValueOnce(new Error("Rate limit"));
    const result = await client.callTool({
      name: "search_code",
      arguments: { query: "error-trigger-unique" },
    });
    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain("Rate limit");
  });
});

describe("search_code scoped to package", () => {
  it("scopes search to a specific package repo and path", async () => {
    mockSearchCode.mockResolvedValueOnce([
      { path: "packages/lean-imt/src/index.ts", repo: "zk-kit/zk-kit", url: "https://example.com", fragment: "insert" },
    ]);
    const result = await client.callTool({
      name: "search_code",
      arguments: { query: "insert", package: "@zk-kit/lean-imt" },
    });
    const text = textOf(result);
    expect(text).toContain("insert");
    // searchCode should be called with repo and path params
    expect(mockSearchCode).toHaveBeenCalledWith("insert", undefined, "zk-kit/zk-kit", "packages/lean-imt");
  });

  it("returns suggestions for unknown package", async () => {
    const result = await client.callTool({
      name: "search_code",
      arguments: { query: "insert", package: "lean" },
    });
    const text = textOf(result);
    expect(text).toContain("not found");
    expect(text).toContain("Did you mean");
  });
});

// --- get_package_readme summary mode ---

describe("get_package_readme summary mode", () => {
  it("returns summary with install and code example", async () => {
    const readmeContent =
      "# Lean IMT\n\nA lean Merkle tree.\n\n## Usage\n\n```typescript\nimport { LeanIMT } from '@zk-kit/lean-imt';\nconst tree = new LeanIMT();\n```\n\nMore docs...";
    mockFetchReadme.mockResolvedValueOnce(readmeContent);
    const result = await client.callTool({
      name: "get_package_readme",
      arguments: { name: "@zk-kit/ecdh", summary: true },
    });
    const text = textOf(result);
    expect(text).toContain("@zk-kit/ecdh");
    expect(text).toContain("npm i @zk-kit/ecdh");
    expect(text).toContain("Quick Example");
    expect(text).toContain("LeanIMT");
    expect(text).toContain("without `summary`");
  });

  it("returns summary without code block when README has none", async () => {
    mockFetchReadme.mockResolvedValueOnce("# Simple\n\nJust text, no code blocks.");
    const result = await client.callTool({
      name: "get_package_readme",
      arguments: { name: "@zk-kit/lean-imt.sol", summary: true },
    });
    const text = textOf(result);
    expect(text).toContain("@zk-kit/lean-imt.sol");
    expect(text).not.toContain("Quick Example");
    expect(text).toContain("without `summary`");
  });

  it("returns full README when summary is false", async () => {
    mockFetchReadme.mockResolvedValueOnce("# Full Docs\n\nDetailed documentation content here.");
    const result = await client.callTool({
      name: "get_package_readme",
      arguments: { name: "@zk-kit/lean-imt.sol", summary: false },
    });
    const text = textOf(result);
    // Should return the full README, NOT summary format
    expect(text).toContain("# Full Docs");
    expect(text).not.toContain("Quick Example");
    expect(text).not.toContain("without `summary`");
  });

  it("shows version in summary when available", async () => {
    mockFetchReadme.mockResolvedValueOnce(
      "# Lean IMT\n\nA lean Merkle tree implementation.\n\n```typescript\nconst tree = new LeanIMT();\n```",
    );
    const result = await client.callTool({
      name: "get_package_readme",
      arguments: { name: "@zk-kit/lean-imt", summary: true },
    });
    const text = textOf(result);
    expect(text).toContain("v1.2.3");
    expect(text).toContain("npm i @zk-kit/lean-imt");
  });
});

// --- get_package_commits ---

describe("get_package_commits", () => {
  it("returns commits for known package", async () => {
    mockFetchCommits.mockResolvedValueOnce([
      {
        sha: "abc1234",
        message: "fix: handle empty tree edge case",
        author: "dev1",
        date: "2024-06-10T12:00:00Z",
        url: "https://github.com/zk-kit/zk-kit/commit/abc1234",
      },
      {
        sha: "def5678",
        message: "feat: add batch insert",
        author: "dev2",
        date: "2024-06-08T10:00:00Z",
        url: "https://github.com/zk-kit/zk-kit/commit/def5678",
      },
    ]);
    const result = await client.callTool({
      name: "get_package_commits",
      arguments: { name: "@zk-kit/lean-imt" },
    });
    const text = textOf(result);
    expect(text).toContain("abc1234");
    expect(text).toContain("fix: handle empty tree edge case");
    expect(text).toContain("dev1");
    expect(text).toContain("batch insert");
  });

  it("returns suggestions when package not found", async () => {
    const result = await client.callTool({
      name: "get_package_commits",
      arguments: { name: "lean" },
    });
    const text = textOf(result);
    expect(text).toContain("not found");
    expect(text).toContain("Did you mean");
  });

  it("handles empty commit history", async () => {
    mockFetchCommits.mockResolvedValueOnce([]);
    const result = await client.callTool({
      name: "get_package_commits",
      arguments: { name: "@zk-kit/poseidon-lite" },
    });
    const text = textOf(result);
    expect(text).toContain("No recent commits found");
  });

  it("caches results", async () => {
    const callsBefore = mockFetchCommits.mock.calls.length;
    mockFetchCommits.mockResolvedValueOnce([
      { sha: "aaa1111", message: "test", author: "dev", date: "2024-01-01T00:00:00Z", url: "https://example.com" },
    ]);
    await client.callTool({
      name: "get_package_commits",
      arguments: { name: "@zk-kit/lean-imt.sol" },
    });
    await client.callTool({
      name: "get_package_commits",
      arguments: { name: "@zk-kit/lean-imt.sol" },
    });
    expect(mockFetchCommits.mock.calls.length - callsBefore).toBe(1);
  });

  it("returns isError on failure", async () => {
    mockFetchCommits.mockRejectedValueOnce(new Error("API error"));
    const result = await client.callTool({
      name: "get_package_commits",
      arguments: { name: "@zk-kit/ecdh" },
    });
    expect(result.isError).toBe(true);
  });
});

// --- zk-concept-explainer prompt ---

describe("prompt: zk-concept-explainer", () => {
  it("returns guide for known concept", async () => {
    const result = await client.getPrompt({
      name: "zk-concept-explainer",
      arguments: { concept: "merkle tree" },
    });
    expect(result.messages).toHaveLength(2);
    const assistantText = (result.messages[1].content as { text: string }).text;
    expect(assistantText).toContain("merkle tree");
    expect(assistantText).toContain("lean-imt");
    expect(assistantText).toContain("Next Steps");
  });

  it("includes user message with concept", async () => {
    const result = await client.getPrompt({
      name: "zk-concept-explainer",
      arguments: { concept: "poseidon hash" },
    });
    const userText = (result.messages[0].content as { text: string }).text;
    expect(userText).toContain("poseidon hash");
  });

  it("shows relevant packages with install commands", async () => {
    const result = await client.getPrompt({
      name: "zk-concept-explainer",
      arguments: { concept: "poseidon" },
    });
    const assistantText = (result.messages[1].content as { text: string }).text;
    expect(assistantText).toContain("poseidon-lite");
    expect(assistantText).toContain("npm i");
  });

  it("filters by language when specified", async () => {
    const result = await client.getPrompt({
      name: "zk-concept-explainer",
      arguments: { concept: "imt", language: "solidity" },
    });
    const assistantText = (result.messages[1].content as { text: string }).text;
    expect(assistantText).toContain("solidity");
    expect(assistantText).toContain("@zk-kit/lean-imt.sol");
  });

  it("returns fallback for unknown concept", async () => {
    const result = await client.getPrompt({
      name: "zk-concept-explainer",
      arguments: { concept: "quantum teleportation" },
    });
    const assistantText = (result.messages[1].content as { text: string }).text;
    expect(assistantText).toContain("couldn't find");
    expect(assistantText).toContain("search_code");
  });

  it("suggests search_code for further exploration", async () => {
    const result = await client.getPrompt({
      name: "zk-concept-explainer",
      arguments: { concept: "ecdh" },
    });
    const assistantText = (result.messages[1].content as { text: string }).text;
    expect(assistantText).toContain("search_code");
  });
});

// --- get_package_downloads ---

describe("get_package_downloads", () => {
  it("returns npm downloads for known package", async () => {
    mockFetchDownloads.mockResolvedValueOnce({
      weeklyDownloads: 1234,
      monthlyDownloads: 5678,
      source: "npm",
    });
    const result = await client.callTool({
      name: "get_package_downloads",
      arguments: { name: "@zk-kit/lean-imt" },
    });
    const text = textOf(result);
    expect(text).toContain("Download Stats");
    expect(text).toContain("1,234");
    expect(text).toContain("5,678");
    expect(text).toContain("npm");
  });

  it("returns suggestions when package not found", async () => {
    const result = await client.callTool({
      name: "get_package_downloads",
      arguments: { name: "lean" },
    });
    const text = textOf(result);
    expect(text).toContain("not found");
    expect(text).toContain("Did you mean");
  });

  it("caches results", async () => {
    const callsBefore = mockFetchDownloads.mock.calls.length;
    mockFetchDownloads.mockResolvedValueOnce({
      weeklyDownloads: 100,
      monthlyDownloads: 400,
      source: "npm",
    });
    await client.callTool({
      name: "get_package_downloads",
      arguments: { name: "@zk-kit/poseidon-lite" },
    });
    await client.callTool({
      name: "get_package_downloads",
      arguments: { name: "@zk-kit/poseidon-lite" },
    });
    expect(mockFetchDownloads.mock.calls.length - callsBefore).toBe(1);
  });

  it("returns isError on failure", async () => {
    mockFetchDownloads.mockRejectedValueOnce(new Error("Network error"));
    const result = await client.callTool({
      name: "get_package_downloads",
      arguments: { name: "@zk-kit/ecdh" },
    });
    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain("Error");
  });
});

// --- get_build_status ---

describe("get_build_status", () => {
  it("returns CI status for a specific repo", async () => {
    mockFetchWorkflowRuns.mockResolvedValueOnce([
      {
        name: "CI",
        status: "completed",
        conclusion: "success",
        branch: "main",
        createdAt: "2024-06-15T12:00:00Z",
        url: "https://example.com/1",
      },
    ]);
    const result = await client.callTool({
      name: "get_build_status",
      arguments: { repo: "zk-kit/zk-kit.solidity" },
    });
    const text = textOf(result);
    expect(text).toContain("CI Status");
    expect(text).toContain("PASS");
    expect(text).toContain("main");
  });

  it("returns CI status for a language", async () => {
    mockFetchWorkflowRuns.mockResolvedValueOnce([
      {
        name: "Tests",
        status: "completed",
        conclusion: "failure",
        branch: "dev",
        createdAt: "2024-06-14T10:00:00Z",
        url: "https://example.com/2",
      },
    ]);
    const result = await client.callTool({
      name: "get_build_status",
      arguments: { language: "circom" },
    });
    const text = textOf(result);
    expect(text).toContain("FAIL");
    expect(text).toContain("dev");
  });

  it("caches results", async () => {
    const callsBefore = mockFetchWorkflowRuns.mock.calls.length;
    mockFetchWorkflowRuns.mockResolvedValueOnce([
      {
        name: "CI",
        status: "completed",
        conclusion: "success",
        branch: "main",
        createdAt: "2024-06-15T12:00:00Z",
        url: "https://example.com",
      },
    ]);
    await client.callTool({ name: "get_build_status", arguments: { language: "circom" } });
    // Second call should use cache
    await client.callTool({ name: "get_build_status", arguments: { language: "circom" } });
    expect(mockFetchWorkflowRuns.mock.calls.length - callsBefore).toBe(1);
  });

  it("returns isError on failure", async () => {
    mockFetchWorkflowRuns.mockRejectedValueOnce(new Error("API error"));
    const result = await client.callTool({
      name: "get_build_status",
      arguments: { repo: "zk-kit/zk-kit.noir" },
    });
    expect(result.isError).toBe(true);
  });
});

// --- migration-guide prompt ---

describe("prompt: migration-guide", () => {
  it("generates version upgrade guide", async () => {
    const result = await client.getPrompt({
      name: "migration-guide",
      arguments: { packageName: "@zk-kit/lean-imt" },
    });
    expect(result.messages).toHaveLength(2);
    const assistantText = (result.messages[1].content as { text: string }).text;
    expect(assistantText).toContain("Upgrade Guide");
    expect(assistantText).toContain("@zk-kit/lean-imt");
    expect(assistantText).toContain("v1.2.3");
    expect(assistantText).toContain("Step 1");
    expect(assistantText).toContain("Step 6");
    expect(assistantText).toContain("get_releases");
    expect(assistantText).toContain("get_package_commits");
  });

  it("shows cross-language alternatives in upgrade guide", async () => {
    const result = await client.getPrompt({
      name: "migration-guide",
      arguments: { packageName: "@zk-kit/lean-imt" },
    });
    const assistantText = (result.messages[1].content as { text: string }).text;
    expect(assistantText).toContain("Switch Language");
    expect(assistantText).toContain("@zk-kit/lean-imt.sol");
  });

  it("generates language migration guide", async () => {
    const result = await client.getPrompt({
      name: "migration-guide",
      arguments: { packageName: "@zk-kit/lean-imt", targetLanguage: "solidity" },
    });
    expect(result.messages).toHaveLength(2);
    const userText = (result.messages[0].content as { text: string }).text;
    expect(userText).toContain("solidity");
    const assistantText = (result.messages[1].content as { text: string }).text;
    expect(assistantText).toContain("Migration:");
    expect(assistantText).toContain("@zk-kit/lean-imt");
    expect(assistantText).toContain("@zk-kit/lean-imt.sol");
    expect(assistantText).toContain("compare_packages");
    expect(assistantText).toContain("get_package_source");
  });

  it("handles target language not available", async () => {
    const result = await client.getPrompt({
      name: "migration-guide",
      arguments: { packageName: "@zk-kit/poseidon-lite", targetLanguage: "solidity" },
    });
    const assistantText = (result.messages[1].content as { text: string }).text;
    expect(assistantText).toContain("does not have a solidity implementation");
    expect(assistantText).toContain("typescript");
  });

  it("returns not-found with suggestions", async () => {
    const result = await client.getPrompt({
      name: "migration-guide",
      arguments: { packageName: "lean" },
    });
    const assistantText = (result.messages[1].content as { text: string }).text;
    expect(assistantText).toContain("not found");
    expect(assistantText).toContain("Did you mean");
  });

  it("sets user message correctly for upgrade", async () => {
    const result = await client.getPrompt({
      name: "migration-guide",
      arguments: { packageName: "@zk-kit/lean-imt" },
    });
    const userText = (result.messages[0].content as { text: string }).text;
    expect(userText).toContain("upgrade");
    expect(userText).toContain("@zk-kit/lean-imt");
  });

  it("no cross-language section for package with no variants", async () => {
    const result = await client.getPrompt({
      name: "migration-guide",
      arguments: { packageName: "@zk-kit/ecdh" },
    });
    const assistantText = (result.messages[1].content as { text: string }).text;
    expect(assistantText).not.toContain("Switch Language");
  });
});

// --- get_cross_language_coverage ---

describe("get_cross_language_coverage", () => {
  it("returns concept x language matrix", async () => {
    const result = await client.callTool({
      name: "get_cross_language_coverage",
      arguments: {},
    });
    const text = textOf(result);
    expect(text).toContain("Cross-Language Coverage Matrix");
    expect(text).toContain("typescript");
    expect(text).toContain("solidity");
    expect(text).toContain("lean-imt");
    expect(text).toContain("poseidon-lite");
  });

  it("shows multi-language concepts", async () => {
    const result = await client.callTool({
      name: "get_cross_language_coverage",
      arguments: {},
    });
    const text = textOf(result);
    expect(text).toContain("Multi-Language Concepts");
    expect(text).toContain("lean-imt");
    expect(text).toContain("typescript");
    expect(text).toContain("solidity");
  });

  it("shows single-language-only concepts", async () => {
    const result = await client.callTool({
      name: "get_cross_language_coverage",
      arguments: {},
    });
    const text = textOf(result);
    expect(text).toContain("Single-Language Only");
    expect(text).toContain("poseidon-lite");
    expect(text).toContain("ecdh");
  });

  it("shows coverage percentage", async () => {
    const result = await client.callTool({
      name: "get_cross_language_coverage",
      arguments: {},
    });
    const text = textOf(result);
    expect(text).toMatch(/\d+% coverage/);
    expect(text).toMatch(/\d+\/\d+ slots filled/);
  });
});

// --- get_dependency_graph ---

describe("get_dependency_graph", () => {
  it("returns dependency graph markdown", async () => {
    const result = await client.callTool({
      name: "get_dependency_graph",
      arguments: {},
    });
    const text = textOf(result);
    expect(text).toContain("ZK-Kit Internal Dependency Graph");
    expect(text).toContain("concepts");
    expect(text).toContain("internal dependencies");
  });

  it("shows independent packages when no internal deps", async () => {
    const result = await client.callTool({
      name: "get_dependency_graph",
      arguments: {},
    });
    const text = textOf(result);
    expect(text).toContain("Independent Packages");
  });

  it("returns reverse dependencies when name is provided", async () => {
    // Use a registry with actual dependencies for this test
    const depRegistry = new PackageRegistry();
    depRegistry.load([
      makePackage({
        name: "@zk-kit/poseidon-lite",
        dirName: "poseidon-lite",
        crossLanguageId: "poseidon-lite",
        zkKitDependencies: [],
      }),
      makePackage({
        name: "@zk-kit/lean-imt",
        dirName: "lean-imt",
        crossLanguageId: "lean-imt",
        zkKitDependencies: ["poseidon-lite"],
      }),
    ]);
    const { server: depServer } = createServer(depRegistry);
    const [depClientT, depServerT] = InMemoryTransport.createLinkedPair();
    await depServer.connect(depServerT);
    const depClient = new Client({ name: "test-dep", version: "1.0.0" });
    await depClient.connect(depClientT);

    const result = await depClient.callTool({
      name: "get_dependency_graph",
      arguments: { name: "@zk-kit/poseidon-lite" },
    });
    const text = textOf(result);
    expect(text).toContain("Dependency Info: poseidon-lite");
    expect(text).toContain("Depended On By");
    expect(text).toContain("lean-imt");

    await depClientT.close();
    await depServerT.close();
  });

  it("shows what a package depends on in reverse dep view", async () => {
    const depRegistry = new PackageRegistry();
    depRegistry.load([
      makePackage({
        name: "@zk-kit/poseidon-lite",
        dirName: "poseidon-lite",
        crossLanguageId: "poseidon-lite",
        zkKitDependencies: [],
      }),
      makePackage({
        name: "@zk-kit/lean-imt",
        dirName: "lean-imt",
        crossLanguageId: "lean-imt",
        zkKitDependencies: ["poseidon-lite"],
      }),
    ]);
    const { server: depServer } = createServer(depRegistry);
    const [depClientT, depServerT] = InMemoryTransport.createLinkedPair();
    await depServer.connect(depServerT);
    const depClient = new Client({ name: "test-dep2", version: "1.0.0" });
    await depClient.connect(depClientT);

    const result = await depClient.callTool({
      name: "get_dependency_graph",
      arguments: { name: "@zk-kit/lean-imt" },
    });
    const text = textOf(result);
    expect(text).toContain("Dependency Info: lean-imt");
    expect(text).toContain("Depends On");
    expect(text).toContain("poseidon-lite");

    await depClientT.close();
    await depServerT.close();
  });

  it("returns suggestions for unknown package name", async () => {
    const result = await client.callTool({
      name: "get_dependency_graph",
      arguments: { name: "lean" },
    });
    const text = textOf(result);
    expect(text).toContain("not found");
    expect(text).toContain("Did you mean");
  });
});

// --- resource template: zk-kit://packages/{language}/{dirName} ---

describe("resource template: packages", () => {
  it("reads package metadata by language and dirName", async () => {
    mockFetchReadme.mockResolvedValueOnce("# Lean IMT docs");
    const result = await client.readResource({
      uri: "zk-kit://packages/typescript/lean-imt",
    });
    const text = (result.contents[0] as { text: string }).text;
    expect(text).toContain("@zk-kit/lean-imt");
    expect(text).toContain("typescript");
    expect(text).toContain("merkle-trees");
    expect(text).toContain("1.2.3");
    expect(text).toContain("npm i @zk-kit/lean-imt");
  });

  it("returns not-found for unknown package", async () => {
    const result = await client.readResource({
      uri: "zk-kit://packages/typescript/nonexistent",
    });
    const text = (result.contents[0] as { text: string }).text;
    expect(text).toContain("not found");
  });

  it("includes README when available", async () => {
    mockFetchReadme.mockResolvedValueOnce("# Poseidon\n\nHash function docs.");
    const result = await client.readResource({
      uri: "zk-kit://packages/typescript/poseidon-lite",
    });
    const text = (result.contents[0] as { text: string }).text;
    expect(text).toContain("@zk-kit/poseidon-lite");
    expect(text).toContain("---");
    expect(text).toContain("# Poseidon");
  });

  it("lists all packages as resources", async () => {
    const { resources } = await client.listResources();
    const pkgResources = resources.filter((r) => r.uri.startsWith("zk-kit://packages/"));
    expect(pkgResources).toHaveLength(TEST_PACKAGES.length);
    expect(pkgResources.some((r) => r.name === "@zk-kit/lean-imt")).toBe(true);
    expect(pkgResources.some((r) => r.name === "@zk-kit/lean-imt.sol")).toBe(true);
  });
});

// --- prompt completions ---

describe("prompt completions", () => {
  it("completes packageName for zk-integration-guide", async () => {
    const result = await client.complete({
      ref: { type: "ref/prompt", name: "zk-integration-guide" },
      argument: { name: "packageName", value: "lean" },
    });
    expect(result.completion.values).toContain("@zk-kit/lean-imt");
    expect(result.completion.values).toContain("@zk-kit/lean-imt.sol");
  });

  it("completes packageName for troubleshoot-package", async () => {
    const result = await client.complete({
      ref: { type: "ref/prompt", name: "troubleshoot-package" },
      argument: { name: "packageName", value: "poseidon" },
    });
    expect(result.completion.values).toContain("@zk-kit/poseidon-lite");
  });

  it("completes packageName for migration-guide", async () => {
    const result = await client.complete({
      ref: { type: "ref/prompt", name: "migration-guide" },
      argument: { name: "packageName", value: "ecdh" },
    });
    expect(result.completion.values).toContain("@zk-kit/ecdh");
  });

  it("returns all packages when value is empty", async () => {
    const result = await client.complete({
      ref: { type: "ref/prompt", name: "troubleshoot-package" },
      argument: { name: "packageName", value: "" },
    });
    expect(result.completion.values.length).toBe(TEST_PACKAGES.length);
  });

  it("completes resource template language variable", async () => {
    const result = await client.complete({
      ref: { type: "ref/resource", uri: "zk-kit://packages/{language}/{dirName}" },
      argument: { name: "language", value: "type" },
    });
    expect(result.completion.values).toContain("typescript");
    expect(result.completion.values).not.toContain("solidity");
  });

  it("completes resource template dirName variable", async () => {
    const result = await client.complete({
      ref: { type: "ref/resource", uri: "zk-kit://packages/{language}/{dirName}" },
      argument: { name: "dirName", value: "lean" },
    });
    expect(result.completion.values).toContain("lean-imt");
  });
});

// --- v0.3.0: resolveRepoSlugs validation ---

describe("repo slug validation", () => {
  it("rejects unknown repo slug in get_repo_stats", async () => {
    const result = await client.callTool({
      name: "get_repo_stats",
      arguments: { repo: "facebook/react" },
    });
    const text = textOf(result);
    expect(text).toContain("Unknown repo");
    expect(text).toContain("facebook/react");
    expect(text).toContain("zk-kit/zk-kit");
  });

  it("rejects unknown repo slug in get_releases", async () => {
    const result = await client.callTool({
      name: "get_releases",
      arguments: { repo: "foo/bar" },
    });
    const text = textOf(result);
    expect(text).toContain("Unknown repo");
  });

  it("rejects unknown repo slug in get_build_status", async () => {
    const result = await client.callTool({
      name: "get_build_status",
      arguments: { repo: "some/other-repo" },
    });
    const text = textOf(result);
    expect(text).toContain("Unknown repo");
  });

  it("accepts valid repo slugs", async () => {
    mockFetchRepoStats.mockResolvedValueOnce({
      slug: "zk-kit/zk-kit.circom",
      description: "Circom toolkit",
      stars: 100,
      forks: 20,
      openIssues: 5,
      lastPushed: "2024-06-01T00:00:00Z",
      license: "MIT",
      topics: [],
      language: "Circom",
      url: "https://github.com/zk-kit/zk-kit.circom",
    });
    const result = await client.callTool({
      name: "get_repo_stats",
      arguments: { repo: "zk-kit/zk-kit.circom" },
    });
    const text = textOf(result);
    expect(text).toContain("zk-kit.circom");
    expect(text).not.toContain("Unknown repo");
  });
});

// --- v0.3.0: search_issues scoping ---

describe("search_issues scoping", () => {
  it("scopes issues to a specific language repo", async () => {
    mockSearchIssues.mockResolvedValueOnce([
      {
        number: 10,
        title: "Solidity bug",
        state: "open",
        url: "https://github.com/...",
        labels: [],
        created: "2024-01-01T00:00:00Z",
      },
    ]);
    const result = await client.callTool({
      name: "search_issues",
      arguments: { query: "bug", language: "solidity" },
    });
    const text = textOf(result);
    expect(text).toContain("Solidity bug");
    expect(mockSearchIssues).toHaveBeenCalledWith("bug", "open", "zk-kit/zk-kit.solidity");
  });

  it("scopes issues to a specific repo slug", async () => {
    mockSearchIssues.mockResolvedValueOnce([]);
    await client.callTool({
      name: "search_issues",
      arguments: { query: "error", repo: "zk-kit/zk-kit.rust" },
    });
    expect(mockSearchIssues).toHaveBeenCalledWith("error", "open", "zk-kit/zk-kit.rust");
  });

  it("rejects invalid repo slug", async () => {
    const result = await client.callTool({
      name: "search_issues",
      arguments: { query: "bug", repo: "facebook/react" },
    });
    const text = textOf(result);
    expect(text).toContain("Unknown repo");
  });

  it("searches org-wide when no scope provided", async () => {
    mockSearchIssues.mockResolvedValueOnce([]);
    await client.callTool({
      name: "search_issues",
      arguments: { query: "unscoped-test-unique" },
    });
    expect(mockSearchIssues).toHaveBeenCalledWith("unscoped-test-unique", "open", undefined);
  });

  it("scopes issues to a specific package", async () => {
    mockSearchIssues.mockResolvedValueOnce([
      {
        number: 77,
        title: "lean-imt insert bug",
        state: "open",
        url: "https://github.com/...",
        labels: ["bug"],
        created: "2024-03-01T00:00:00Z",
      },
    ]);
    const result = await client.callTool({
      name: "search_issues",
      arguments: { query: "insert bug", package: "@zk-kit/lean-imt" },
    });
    const text = textOf(result);
    expect(text).toContain("lean-imt insert bug");
    // Should scope to the TS repo and append dirName to query
    expect(mockSearchIssues).toHaveBeenCalledWith("insert bug lean-imt", "open", "zk-kit/zk-kit");
  });

  it("returns suggestions when package not found in issue search", async () => {
    const result = await client.callTool({
      name: "search_issues",
      arguments: { query: "bug", package: "lean" },
    });
    const text = textOf(result);
    expect(text).toContain("not found");
    expect(text).toContain("Did you mean");
  });
});

// --- v0.3.0: response size limits ---

describe("response size limits", () => {
  it("truncates oversized README with hint", async () => {
    const largeContent = `# Large README\n\n${"x".repeat(60_000)}`;
    mockFetchReadme.mockResolvedValueOnce(largeContent);
    const result = await client.callTool({
      name: "get_package_readme",
      arguments: { name: "zk-kit-baby-jubjub" },
    });
    const text = textOf(result);
    expect(text).toContain("Content truncated");
    expect(text).toContain("summary: true");
    expect(text.length).toBeLessThan(largeContent.length);
  });

  it("does not truncate README within limit", async () => {
    const normalContent = `# Normal README\n\n${"Content here.\n".repeat(100)}`;
    mockFetchReadme.mockResolvedValueOnce(normalContent);
    const result = await client.callTool({
      name: "get_package_readme",
      arguments: { name: "@zk-kit/lean-imt" },
    });
    const text = textOf(result);
    expect(text).not.toContain("Content truncated");
  });

  it("truncates oversized source file with hint", async () => {
    const largeFile = `export const data = [\n${"  1,\n".repeat(20_000)}];`;
    mockFetchRawFile.mockResolvedValueOnce(largeFile);
    const result = await client.callTool({
      name: "get_package_source",
      arguments: { name: "@zk-kit/poseidon-lite", filePath: "src/index.ts" },
    });
    const text = textOf(result);
    expect(text).toContain("truncated at 50000 characters");
    expect(text.length).toBeLessThan(largeFile.length + 1000); // +1000 for wrapper markdown
  });
});

// --- v0.3.0: get_package_api ---

describe("get_package_api", () => {
  it("returns main entry file for TypeScript package", async () => {
    mockFetchRawFile.mockResolvedValueOnce("export function leanIMT() { return 42; }");
    const result = await client.callTool({
      name: "get_package_api",
      arguments: { name: "@zk-kit/lean-imt" },
    });
    const text = textOf(result);
    expect(text).toContain("API");
    expect(text).toContain("src/index.ts");
    expect(text).toContain("```typescript");
    expect(text).toContain("leanIMT");
  });

  it("returns suggestions for unknown package", async () => {
    const result = await client.callTool({
      name: "get_package_api",
      arguments: { name: "lean" },
    });
    const text = textOf(result);
    expect(text).toContain("not found");
    expect(text).toContain("Did you mean");
  });

  it("returns not-found message when entry file missing", async () => {
    // All candidates return null
    mockFetchRawFile.mockResolvedValue(null);
    const result = await client.callTool({
      name: "get_package_api",
      arguments: { name: "@zk-kit/poseidon-lite" },
    });
    const text = textOf(result);
    expect(text).toContain("Could not find the main entry file");
    expect(text).toContain("src/index.ts");
    expect(text).toContain("get_package_source");
    mockFetchRawFile.mockReset();
  });

  it("tries Solidity-specific paths for .sol packages", async () => {
    // First candidate (PascalCase) not found
    mockFetchRawFile.mockResolvedValueOnce(null);
    // Second candidate (dirName) found
    mockFetchRawFile.mockResolvedValueOnce("pragma solidity ^0.8.0;\ncontract LeanIMT { }");
    const result = await client.callTool({
      name: "get_package_api",
      arguments: { name: "@zk-kit/lean-imt.sol" },
    });
    const text = textOf(result);
    expect(text).toContain("```solidity");
    expect(text).toContain("LeanIMT");
  });

  it("returns isError on failure", async () => {
    mockFetchRawFile.mockRejectedValueOnce(new Error("API error"));
    const result = await client.callTool({
      name: "get_package_api",
      arguments: { name: "@zk-kit/ecdh" },
    });
    expect(result.isError).toBe(true);
  });

  it("truncates oversized API files", async () => {
    const largeFile = `export const data = ${"x".repeat(60_000)}`;
    mockFetchRawFile.mockResolvedValueOnce(largeFile);
    const result = await client.callTool({
      name: "get_package_api",
      arguments: { name: "@zk-kit/lean-imt" },
    });
    const text = textOf(result);
    expect(text).toContain("truncated at 50000 characters");
  });
});

// --- v1.0: get_package_changelog ---

describe("get_package_changelog", () => {
  it("returns changelog content for known package", async () => {
    mockFetchRawFile.mockResolvedValueOnce("# Changelog\n\n## 1.2.0\n\n- Added batch insert\n\n## 1.1.0\n\n- Bug fix");
    const result = await client.callTool({
      name: "get_package_changelog",
      arguments: { name: "@zk-kit/lean-imt" },
    });
    const text = textOf(result);
    expect(text).toContain("# Changelog");
    expect(text).toContain("1.2.0");
    expect(text).toContain("batch insert");
  });

  it("returns suggestions for unknown package", async () => {
    const result = await client.callTool({
      name: "get_package_changelog",
      arguments: { name: "lean" },
    });
    const text = textOf(result);
    expect(text).toContain("not found");
    expect(text).toContain("Did you mean");
  });

  it("returns helpful message when no changelog exists", async () => {
    mockFetchRawFile.mockResolvedValueOnce(null); // CHANGELOG.md
    mockFetchRawFile.mockResolvedValueOnce(null); // changelog.md
    const result = await client.callTool({
      name: "get_package_changelog",
      arguments: { name: "@zk-kit/poseidon-lite" },
    });
    const text = textOf(result);
    expect(text).toContain("No CHANGELOG.md found");
    expect(text).toContain("get_releases");
    expect(text).toContain("get_package_commits");
  });

  it("falls back to lowercase changelog.md", async () => {
    mockFetchRawFile.mockResolvedValueOnce(null); // CHANGELOG.md not found
    mockFetchRawFile.mockResolvedValueOnce("# changelog\n\n## 0.1.0\n\n- Initial"); // changelog.md
    const result = await client.callTool({
      name: "get_package_changelog",
      arguments: { name: "@zk-kit/ecdh" },
    });
    const text = textOf(result);
    expect(text).toContain("# changelog");
    expect(text).toContain("Initial");
  });

  it("truncates oversized changelog", async () => {
    const largeChangelog = `# Changelog\n\n${"- Entry\n".repeat(10_000)}`;
    mockFetchRawFile.mockResolvedValueOnce(largeChangelog);
    const result = await client.callTool({
      name: "get_package_changelog",
      arguments: { name: "@zk-kit/lean-imt.sol" },
    });
    const text = textOf(result);
    expect(text).toContain("Content truncated");
    expect(text).toContain("CHANGELOG.md");
    expect(text.length).toBeLessThan(largeChangelog.length);
  });

  it("caches results", async () => {
    const callsBefore = mockFetchRawFile.mock.calls.length;
    mockFetchRawFile.mockResolvedValueOnce("# Changelog\n\n## 1.0.0\n\n- Release");
    await client.callTool({
      name: "get_package_changelog",
      arguments: { name: "zk-kit-baby-jubjub" },
    });
    await client.callTool({
      name: "get_package_changelog",
      arguments: { name: "zk-kit-baby-jubjub" },
    });
    // Only one fetch call for the first invocation
    expect(mockFetchRawFile.mock.calls.length - callsBefore).toBe(1);
  });

  it("returns isError on failure", async () => {
    mockFetchRawFile.mockRejectedValueOnce(new Error("Network error"));
    const result = await client.callTool({
      name: "get_package_changelog",
      arguments: { name: "@zk-kit/ecdh" },
    });
    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain("Error");
  });
});
