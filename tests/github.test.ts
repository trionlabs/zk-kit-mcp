import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  detectLanguageFromExtension,
  extractDescriptionFromReadme,
  extractFirstCodeBlock,
  fetchDirectoryListing,
  fetchDirectoryTree,
  fetchManifestInfo,
  fetchPackageCommits,
  fetchPackageDependencies,
  fetchPackageDownloads,
  fetchRawFile,
  fetchReadme,
  fetchReleases,
  fetchRepoStats,
  fetchWorkflowRuns,
  formatCodeSearchResults,
  formatCommit,
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
  truncate,
} from "../src/github.js";

const mockFetch = vi.fn();

beforeEach(() => {
  mockFetch.mockReset();
  vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("truncate", () => {
  it("returns short strings unchanged", () => {
    expect(truncate("hello", 100)).toBe("hello");
  });

  it("truncates at word boundary with ellipsis", () => {
    const long = "The quick brown fox jumps over the lazy dog";
    const result = truncate(long, 20);
    expect(result).toBe("The quick brown fox...");
    expect(result.endsWith("...")).toBe(true);
    // No partial word: "fox" fits within 20 chars, "jumps" doesn't
    expect(result).not.toContain("jump");
  });

  it("handles exact boundary", () => {
    expect(truncate("exact", 5)).toBe("exact");
  });

  it("handles no spaces within limit", () => {
    const result = truncate("superlongwordwithoutspaces and more", 20);
    expect(result).toContain("...");
  });
});

describe("extractDescriptionFromReadme", () => {
  it("extracts from HTML <p> tags (Solidity READMEs)", () => {
    const html = `<p align="center">
    <h1 align="center">
         Lean Incremental Merkle Tree (Solidity)
    </h1>
    <p align="center">Lean Incremental Merkle tree implementation in Solidity.</p>
</p>`;
    expect(extractDescriptionFromReadme(html)).toBe("Lean Incremental Merkle tree implementation in Solidity.");
  });

  it("extracts from Markdown (non-heading, non-HTML lines)", () => {
    const md = "# Lean IMT\n\nA lean Merkle tree for Noir.\n\nMore details...";
    expect(extractDescriptionFromReadme(md)).toBe("A lean Merkle tree for Noir.");
  });

  it("truncates long descriptions at word boundary", () => {
    const long = `# Title\n\n${"word ".repeat(100)}`;
    const result = extractDescriptionFromReadme(long);
    expect(result.length).toBeLessThanOrEqual(203); // 200 + "..."
    expect(result.endsWith("...")).toBe(true);
  });

  it("returns empty for content with only headings and HTML", () => {
    expect(extractDescriptionFromReadme("# Just a heading\n<p><img></p>")).toBe("");
  });

  it("skips badge/image lines in markdown", () => {
    const md = "# Title\n\n[![badge](url)](link)\n![img](url)\n\nActual description here.";
    expect(extractDescriptionFromReadme(md)).toBe("Actual description here.");
  });
});

describe("fetchDirectoryListing", () => {
  it("returns directory names from GitHub Contents API", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [
        { name: "lean-imt", type: "dir" },
        { name: "poseidon-lite", type: "dir" },
        { name: "README.md", type: "file" },
      ],
    });

    const dirs = await fetchDirectoryListing("zk-kit/zk-kit", "packages");
    expect(dirs).toEqual(["lean-imt", "poseidon-lite"]);
    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.github.com/repos/zk-kit/zk-kit/contents/packages",
      expect.objectContaining({ headers: expect.any(Object) }),
    );
  });

  it("throws on non-ok response", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });
    await expect(fetchDirectoryListing("zk-kit/zk-kit", "packages")).rejects.toThrow("GitHub API 404");
  });

  it("throws descriptive error on 403 with rate limit headers", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 403,
      headers: new Headers({
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": "1706000000",
      }),
    });
    try {
      await fetchDirectoryListing("zk-kit/zk-kit", "packages");
      expect.fail("Should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(Error);
      const msg = (e as Error).message;
      expect(msg).toContain("rate limit exceeded");
      expect(msg).toContain("GITHUB_TOKEN");
      expect(msg).toContain("2024-01-23");
    }
  });

  it("falls back to generic error on 403 without rate limit headers", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 403,
      headers: new Headers({}),
    });
    await expect(fetchDirectoryListing("zk-kit/zk-kit", "packages")).rejects.toThrow("GitHub API 403");
  });

  it("handles malformed rate limit reset header gracefully", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 403,
      headers: new Headers({
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": "not-a-number",
      }),
    });
    try {
      await fetchDirectoryListing("zk-kit/zk-kit", "packages");
      expect.fail("Should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(Error);
      const msg = (e as Error).message;
      expect(msg).toContain("rate limit exceeded");
      expect(msg).toContain("unknown");
    }
  });
});

describe("fetchRawFile", () => {
  it("returns file content from raw.githubusercontent.com", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: async () => "# Hello",
    });

    const content = await fetchRawFile("zk-kit/zk-kit", "main", "packages/lean-imt/README.md");
    expect(content).toBe("# Hello");
  });

  it("returns null on 404", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });
    const content = await fetchRawFile("zk-kit/zk-kit", "main", "packages/nope/README.md");
    expect(content).toBeNull();
  });

  it("returns null on network error", async () => {
    mockFetch.mockRejectedValueOnce(new Error("Network error"));
    const content = await fetchRawFile("zk-kit/zk-kit", "main", "packages/lean-imt/README.md");
    expect(content).toBeNull();
  });
});

describe("fetchReadme", () => {
  it("returns substantial README from primary path", async () => {
    const longContent = `# Package\n${"Documentation content.\n".repeat(20)}`;
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: async () => longContent,
    });

    const readme = await fetchReadme("zk-kit/zk-kit", "main", "packages", "lean-imt");
    expect(readme).toContain("Documentation content.");
  });

  it("falls back to contracts/README.md when primary is a redirect", async () => {
    // Primary README is a redirect (short)
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: async () => "contracts/README.md",
    });
    // contracts/README.md has the real content
    const realContent = `<p align="center"><h1>Title</h1></p>\n${"x".repeat(200)}`;
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: async () => realContent,
    });

    const readme = await fetchReadme("zk-kit/zk-kit.solidity", "main", "packages", "lean-imt");
    expect(readme).toBe(realContent);
  });

  it("returns null when all paths 404", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });
    mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });

    const readme = await fetchReadme("zk-kit/zk-kit", "main", "packages", "nonexistent");
    expect(readme).toBeNull();
  });

  it("does not double-fetch primary path when it returns short content", async () => {
    // Primary README is a redirect (short)
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: async () => "contracts/README.md",
    });
    // contracts/README.md also short
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: async () => "Also short",
    });

    const readme = await fetchReadme("zk-kit/zk-kit.solidity", "main", "packages", "lean-imt");
    // Should return the primary content as fallback
    expect(readme).toBe("contracts/README.md");
    // Should only fetch 2 times (primary + contracts), NOT 3 (no double-fetch of primary)
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});

describe("fetchReleases", () => {
  it("parses releases from GitHub API", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [
        {
          tag_name: "v1.0.0",
          name: "Release 1.0.0",
          published_at: "2024-01-15T00:00:00Z",
          html_url: "https://github.com/zk-kit/zk-kit/releases/tag/v1.0.0",
          body: "Initial release",
        },
      ],
    });

    const releases = await fetchReleases("zk-kit/zk-kit", 5);
    expect(releases).toHaveLength(1);
    expect(releases[0].tag).toBe("v1.0.0");
    expect(releases[0].name).toBe("Release 1.0.0");
  });
});

describe("searchIssues", () => {
  it("parses search results from GitHub API", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        items: [
          {
            number: 42,
            title: "Bug in lean-imt",
            state: "open",
            html_url: "https://github.com/zk-kit/zk-kit/issues/42",
            labels: [{ name: "bug" }],
            created_at: "2024-06-01T00:00:00Z",
          },
        ],
      }),
    });

    const issues = await searchIssues("lean-imt", "open");
    expect(issues).toHaveLength(1);
    expect(issues[0].number).toBe(42);
    expect(issues[0].labels).toEqual(["bug"]);
  });

  it("properly encodes the full search query", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ items: [] }),
    });

    await searchIssues("lean imt bug", "open");

    const calledUrl = mockFetch.mock.calls[0][0] as string;
    // The full query should be URL-encoded as one unit
    expect(calledUrl).toContain(encodeURIComponent("lean imt bug org:zk-kit state:open"));
  });

  it("omits state qualifier for 'all'", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ items: [] }),
    });

    await searchIssues("test", "all");

    const calledUrl = mockFetch.mock.calls[0][0] as string;
    expect(calledUrl).not.toContain("state");
    expect(calledUrl).toContain(encodeURIComponent("test org:zk-kit"));
  });

  it("uses repo: qualifier when scopeRepo is provided", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ items: [] }),
    });

    await searchIssues("bug", "open", "zk-kit/zk-kit.solidity");

    const calledUrl = mockFetch.mock.calls[0][0] as string;
    expect(calledUrl).toContain(encodeURIComponent("bug repo:zk-kit/zk-kit.solidity state:open"));
    expect(calledUrl).not.toContain("org%3Azk-kit");
  });

  it("falls back to org:zk-kit when no scopeRepo", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ items: [] }),
    });

    await searchIssues("test", "open");

    const calledUrl = mockFetch.mock.calls[0][0] as string;
    expect(calledUrl).toContain(encodeURIComponent("org:zk-kit"));
  });
});

describe("formatRelease", () => {
  it("formats a release as markdown", () => {
    const text = formatRelease({
      tag: "v1.0.0",
      name: "Release 1.0.0",
      date: "2024-01-15T00:00:00Z",
      url: "https://example.com",
      body: "Changelog here",
    });
    expect(text).toContain("Release 1.0.0");
    expect(text).toContain("2024-01-15");
    expect(text).toContain("Changelog here");
  });
});

describe("formatIssue", () => {
  it("formats an issue as text", () => {
    const text = formatIssue({
      number: 42,
      title: "Bug in lean-imt",
      state: "open",
      url: "https://example.com",
      labels: ["bug", "help wanted"],
      created: "2024-06-01T00:00:00Z",
    });
    expect(text).toContain("#42");
    expect(text).toContain("Bug in lean-imt");
    expect(text).toContain("bug, help wanted");
  });
});

// fetchManifestInfo

describe("fetchManifestInfo", () => {
  it("parses description and version from package.json (typescript)", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: async () => JSON.stringify({ name: "@zk-kit/lean-imt", description: "Lean IMT", version: "1.2.3" }),
    });

    const info = await fetchManifestInfo("zk-kit/zk-kit", "main", "packages", "lean-imt", "typescript");
    expect(info.description).toBe("Lean IMT");
    expect(info.version).toBe("1.2.3");
  });

  it("parses description and version from Cargo.toml (rust)", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: async () => '[package]\nname = "zk-kit-lean-imt"\ndescription = "Lean IMT in Rust"\nversion = "0.1.0"\n',
    });

    const info = await fetchManifestInfo("zk-kit/zk-kit.rust", "main", "crates", "lean-imt", "rust");
    expect(info.description).toBe("Lean IMT in Rust");
    expect(info.version).toBe("0.1.0");
  });

  it("returns undefined version for noir", async () => {
    const noirReadme = `# Lean IMT\n\nA lean Merkle tree for Noir.\n\n${"Additional documentation. ".repeat(10)}`;
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: async () => noirReadme,
    });

    const info = await fetchManifestInfo("zk-kit/zk-kit.noir", "main", "packages", "lean-imt", "noir");
    expect(info.version).toBeUndefined();
    expect(info.description).toBe("A lean Merkle tree for Noir.");
  });

  it("returns undefined version when package.json has no version field", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: async () => JSON.stringify({ name: "test", description: "Test pkg" }),
    });

    const info = await fetchManifestInfo("zk-kit/zk-kit", "main", "packages", "test", "typescript");
    expect(info.description).toBe("Test pkg");
    expect(info.version).toBeUndefined();
  });

  it("extracts ZK-Kit dependencies from package.json (typescript)", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: async () =>
        JSON.stringify({
          name: "@zk-kit/eddsa-poseidon",
          description: "EdDSA with Poseidon",
          version: "1.0.0",
          dependencies: { "@zk-kit/poseidon-lite": "^0.2.0", "@zk-kit/baby-jubjub": "^1.0.0", ethers: "^6.0.0" },
        }),
    });

    const info = await fetchManifestInfo("zk-kit/zk-kit", "main", "packages", "eddsa-poseidon", "typescript");
    expect(info.zkKitDependencies).toEqual(["poseidon-lite", "baby-jubjub"]);
  });

  it("strips .sol suffix from solidity ZK-Kit deps", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: async () =>
        JSON.stringify({
          name: "@zk-kit/test.sol",
          description: "Test",
          dependencies: { "@zk-kit/poseidon-lite.sol": "^1.0.0" },
        }),
    });

    const info = await fetchManifestInfo("zk-kit/zk-kit.solidity", "main", "packages", "test", "solidity");
    expect(info.zkKitDependencies).toEqual(["poseidon-lite"]);
  });

  it("extracts ZK-Kit dependencies from Cargo.toml (rust)", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: async () =>
        `[package]\nname = "zk-kit-eddsa"\ndescription = "EdDSA"\nversion = "0.1.0"\n\n[dependencies]\nzk-kit-poseidon-lite = "0.2"\nsha2 = "0.10"\n`,
    });

    const info = await fetchManifestInfo("zk-kit/zk-kit.rust", "main", "crates", "eddsa", "rust");
    expect(info.zkKitDependencies).toEqual(["poseidon-lite"]);
  });

  it("returns empty zkKitDependencies for noir", async () => {
    const noirReadme = `# Test\n\nA noir package.\n\n${"Additional documentation. ".repeat(10)}`;
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: async () => noirReadme,
    });

    const info = await fetchManifestInfo("zk-kit/zk-kit.noir", "main", "packages", "test", "noir");
    expect(info.zkKitDependencies).toEqual([]);
  });

  it("returns empty zkKitDependencies when no ZK-Kit deps exist", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: async () => JSON.stringify({ name: "test", description: "Test", dependencies: { ethers: "^6.0.0" } }),
    });

    const info = await fetchManifestInfo("zk-kit/zk-kit", "main", "packages", "test", "typescript");
    expect(info.zkKitDependencies).toEqual([]);
  });
});

// fetchPackageDependencies

describe("fetchPackageDependencies", () => {
  it("parses TS package.json deps", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: async () =>
        JSON.stringify({
          dependencies: { "poseidon-lite": "^0.2.0" },
          devDependencies: { vitest: "^1.0.0" },
          peerDependencies: { ethers: "^6.0.0" },
        }),
    });

    const deps = await fetchPackageDependencies("zk-kit/zk-kit", "main", "packages", "lean-imt", "typescript");
    expect(deps).not.toBeNull();
    expect(deps!.dependencies).toEqual({ "poseidon-lite": "^0.2.0" });
    expect(deps!.devDependencies).toEqual({ vitest: "^1.0.0" });
    expect(deps!.peerDependencies).toEqual({ ethers: "^6.0.0" });
  });

  it("parses Rust Cargo.toml deps", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: async () =>
        `[package]\nname = "test"\nversion = "0.1.0"\n\n[dependencies]\nsha2 = "0.10"\ntokio = { version = "1.0", features = ["full"] }\n\n[dev-dependencies]\ncriterion = "0.5"\n`,
    });

    const deps = await fetchPackageDependencies("zk-kit/zk-kit.rust", "main", "crates", "lean-imt", "rust");
    expect(deps).not.toBeNull();
    expect(deps!.dependencies).toHaveProperty("sha2", "0.10");
    expect(deps!.dependencies).toHaveProperty("tokio", "1.0");
    expect(deps!.devDependencies).toHaveProperty("criterion", "0.5");
  });

  it("parses Noir Nargo.toml deps", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: async () =>
        `[package]\nname = "lean_imt"\ntype = "lib"\n\n[dependencies]\nstd = "0.1.0"\nutils = { tag = "v0.2.0", git = "https://github.com/example/repo" }\n`,
    });

    const deps = await fetchPackageDependencies("zk-kit/zk-kit.noir", "main", "packages", "lean-imt", "noir");
    expect(deps).not.toBeNull();
    expect(deps!.dependencies).toHaveProperty("std", "0.1.0");
    expect(deps!.dependencies).toHaveProperty("utils", "v0.2.0");
    expect(deps!.peerDependencies).toEqual({});
  });

  it("returns null on 404", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });

    const deps = await fetchPackageDependencies("zk-kit/zk-kit", "main", "packages", "nope", "typescript");
    expect(deps).toBeNull();
  });

  it("returns null on invalid JSON", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: async () => "not json",
    });

    const deps = await fetchPackageDependencies("zk-kit/zk-kit", "main", "packages", "bad", "typescript");
    expect(deps).toBeNull();
  });
});

describe("formatDependencies", () => {
  it("formats deps as markdown", () => {
    const text = formatDependencies("@zk-kit/lean-imt", "typescript", {
      dependencies: { a: "1.0", b: "2.0" },
      devDependencies: { c: "3.0" },
      peerDependencies: {},
    });
    expect(text).toContain("Dependencies for @zk-kit/lean-imt");
    expect(text).toContain("`a`: 1.0");
    expect(text).toContain("Dev Dependencies");
    expect(text).not.toContain("Peer Dependencies");
  });

  it("shows no-deps message when all empty", () => {
    const text = formatDependencies("test", "typescript", {
      dependencies: {},
      devDependencies: {},
      peerDependencies: {},
    });
    expect(text).toContain("No dependencies found");
  });
});

// fetchRepoStats

describe("fetchRepoStats", () => {
  it("parses repo stats from GitHub API", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        full_name: "zk-kit/zk-kit",
        description: "ZK toolkit",
        stargazers_count: 500,
        forks_count: 100,
        open_issues_count: 10,
        pushed_at: "2024-06-15T00:00:00Z",
        license: { spdx_id: "MIT" },
        topics: ["zk", "crypto"],
        language: "TypeScript",
        html_url: "https://github.com/zk-kit/zk-kit",
      }),
    });

    const stats = await fetchRepoStats("zk-kit/zk-kit");
    expect(stats.stars).toBe(500);
    expect(stats.license).toBe("MIT");
    expect(stats.topics).toEqual(["zk", "crypto"]);
  });

  it("handles null license and description", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        full_name: "zk-kit/test",
        description: null,
        stargazers_count: 0,
        forks_count: 0,
        open_issues_count: 0,
        pushed_at: "2024-01-01T00:00:00Z",
        license: null,
        topics: [],
        language: null,
        html_url: "https://github.com/zk-kit/test",
      }),
    });

    const stats = await fetchRepoStats("zk-kit/test");
    expect(stats.license).toBe("None");
    expect(stats.description).toBe("");
    expect(stats.language).toBe("Unknown");
  });
});

describe("formatRepoStats", () => {
  it("formats stats as markdown table", () => {
    const text = formatRepoStats({
      slug: "zk-kit/zk-kit",
      description: "ZK toolkit",
      stars: 500,
      forks: 100,
      openIssues: 10,
      lastPushed: "2024-06-15T00:00:00Z",
      license: "MIT",
      topics: ["zk", "crypto"],
      language: "TypeScript",
      url: "https://github.com/zk-kit/zk-kit",
    });
    expect(text).toContain("500");
    expect(text).toContain("MIT");
    expect(text).toContain("zk, crypto");
  });

  it("omits topics row when empty", () => {
    const text = formatRepoStats({
      slug: "test",
      description: "",
      stars: 0,
      forks: 0,
      openIssues: 0,
      lastPushed: "2024-01-01T00:00:00Z",
      license: "None",
      topics: [],
      language: "Unknown",
      url: "https://example.com",
    });
    expect(text).not.toContain("Topics");
  });
});

// fetchDirectoryTree

describe("fetchDirectoryTree", () => {
  it("returns flat directory listing via Git Trees API", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        tree: [
          { path: "packages/lean-imt/index.ts", type: "blob", size: 1024 },
          { path: "packages/lean-imt/README.md", type: "blob", size: 200 },
          { path: "packages/other/file.ts", type: "blob", size: 100 }, // outside scope
        ],
        truncated: false,
      }),
    });

    const entries = await fetchDirectoryTree("zk-kit/zk-kit", "main", "packages/lean-imt");
    expect(entries).toHaveLength(2);
    expect(entries[0].name).toBe("index.ts");
    expect(entries[0].type).toBe("file");
    expect(entries[0].size).toBe(1024);
  });

  it("returns nested directory structure in single API call", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        tree: [
          { path: "packages/lean-imt/src", type: "tree" },
          { path: "packages/lean-imt/src/index.ts", type: "blob", size: 500 },
          { path: "packages/lean-imt/package.json", type: "blob", size: 300 },
        ],
        truncated: false,
      }),
    });

    const entries = await fetchDirectoryTree("zk-kit/zk-kit", "main", "packages/lean-imt");
    expect(entries).toHaveLength(3); // src dir + index.ts + package.json
    expect(entries.find((e) => e.name === "index.ts")?.path).toBe("src/index.ts");
    // Only 1 API call instead of N recursive calls
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

describe("formatDirectoryTree", () => {
  it("formats entries with indentation and sizes", () => {
    const text = formatDirectoryTree([
      { name: "src", path: "src", type: "dir" },
      { name: "index.ts", path: "src/index.ts", type: "file", size: 1024 },
      { name: "package.json", path: "package.json", type: "file", size: 200 },
    ]);
    expect(text).toContain("src/");
    expect(text).toContain("  index.ts (1.0KB)");
    expect(text).toContain("package.json (200B)");
  });
});

describe("detectLanguageFromExtension", () => {
  it("detects common extensions", () => {
    expect(detectLanguageFromExtension("index.ts")).toBe("typescript");
    expect(detectLanguageFromExtension("Contract.sol")).toBe("solidity");
    expect(detectLanguageFromExtension("lib.rs")).toBe("rust");
    expect(detectLanguageFromExtension("main.circom")).toBe("circom");
    expect(detectLanguageFromExtension("circuit.nr")).toBe("noir");
  });

  it("returns empty string for unknown extensions", () => {
    expect(detectLanguageFromExtension("file.xyz")).toBe("");
  });
});

// --- searchCode ---

describe("searchCode", () => {
  it("parses code search results from GitHub API", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        items: [
          {
            name: "lean-imt.ts",
            path: "packages/lean-imt/src/lean-imt.ts",
            repository: { full_name: "zk-kit/zk-kit" },
            html_url: "https://github.com/zk-kit/zk-kit/blob/main/packages/lean-imt/src/lean-imt.ts",
            text_matches: [{ fragment: "export function insert(tree: LeanIMT)" }],
          },
        ],
      }),
    });

    const results = await searchCode("function insert");
    expect(results).toHaveLength(1);
    expect(results[0].path).toBe("packages/lean-imt/src/lean-imt.ts");
    expect(results[0].repo).toBe("zk-kit/zk-kit");
    expect(results[0].fragment).toContain("insert");
  });

  it("handles empty results", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ items: [] }),
    });

    const results = await searchCode("nonexistent");
    expect(results).toEqual([]);
  });

  it("handles missing text_matches gracefully", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        items: [
          {
            name: "test.ts",
            path: "test.ts",
            repository: { full_name: "zk-kit/zk-kit" },
            html_url: "https://example.com",
            text_matches: undefined,
          },
        ],
      }),
    });

    const results = await searchCode("test");
    expect(results[0].fragment).toBe("");
  });

  it("throws on rate limit", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 403,
      headers: new Headers({
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": "1706000000",
      }),
    });

    await expect(searchCode("test")).rejects.toThrow("rate limit");
  });
});

describe("formatCodeSearchResults", () => {
  it("formats results with fragments", () => {
    const text = formatCodeSearchResults([
      { path: "src/index.ts", repo: "zk-kit/zk-kit", url: "https://example.com", fragment: "const x = 1;" },
    ]);
    expect(text).toContain("zk-kit/zk-kit");
    expect(text).toContain("src/index.ts");
    expect(text).toContain("const x = 1;");
  });

  it("returns no-matches message for empty results", () => {
    expect(formatCodeSearchResults([])).toBe("No code matches found.");
  });
});

// --- extractFirstCodeBlock ---

describe("extractFirstCodeBlock", () => {
  it("extracts first code block with language hint", () => {
    const md =
      "# Package\n\nSome text\n\n```typescript\nconst x = 1;\nconsole.log(x);\n```\n\nMore text\n\n```javascript\nconst y = 2;\n```";
    const result = extractFirstCodeBlock(md);
    expect(result).not.toBeNull();
    expect(result!.language).toBe("typescript");
    expect(result!.code).toBe("const x = 1;\nconsole.log(x);");
  });

  it("extracts code block without language hint", () => {
    const md = "# Package\n\n```\nnpm install something\n```";
    const result = extractFirstCodeBlock(md);
    expect(result).not.toBeNull();
    expect(result!.language).toBe("");
    expect(result!.code).toBe("npm install something");
  });

  it("returns null when no code blocks exist", () => {
    const md = "# Package\n\nJust text, no code blocks.";
    expect(extractFirstCodeBlock(md)).toBeNull();
  });
});

// --- searchCode scoping ---

describe("searchCode scoping", () => {
  it("adds repo: qualifier when scopeRepo is provided", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ items: [] }),
    });

    await searchCode("insert", undefined, "zk-kit/zk-kit");

    const calledUrl = mockFetch.mock.calls[0][0] as string;
    expect(calledUrl).toContain(encodeURIComponent("insert repo:zk-kit/zk-kit"));
    expect(calledUrl).not.toContain("org%3Azk-kit");
  });

  it("adds path: qualifier when scopePath is provided", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ items: [] }),
    });

    await searchCode("insert", undefined, "zk-kit/zk-kit", "packages/lean-imt");

    const calledUrl = mockFetch.mock.calls[0][0] as string;
    expect(calledUrl).toContain(encodeURIComponent("path:packages/lean-imt"));
  });

  it("falls back to org:zk-kit when no scope", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ items: [] }),
    });

    await searchCode("insert");

    const calledUrl = mockFetch.mock.calls[0][0] as string;
    expect(calledUrl).toContain(encodeURIComponent("org:zk-kit"));
  });
});

// --- fetchPackageCommits ---

describe("fetchPackageCommits", () => {
  it("parses commits from GitHub API", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [
        {
          sha: "abc1234567890",
          commit: {
            message: "fix: handle empty tree\n\nDetailed description",
            author: { name: "dev1", date: "2024-06-10T12:00:00Z" },
          },
          html_url: "https://github.com/zk-kit/zk-kit/commit/abc1234567890",
        },
      ],
    });

    const commits = await fetchPackageCommits("zk-kit/zk-kit", "packages/lean-imt", 5);
    expect(commits).toHaveLength(1);
    expect(commits[0].sha).toBe("abc1234"); // truncated to 7
    expect(commits[0].message).toBe("fix: handle empty tree"); // first line only
    expect(commits[0].author).toBe("dev1");
  });

  it("returns empty array for no commits", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [],
    });

    const commits = await fetchPackageCommits("zk-kit/zk-kit", "packages/nope", 10);
    expect(commits).toEqual([]);
  });
});

describe("formatCommit", () => {
  it("formats a single commit", () => {
    const text = formatCommit({
      sha: "abc1234",
      message: "fix: handle edge case",
      author: "dev1",
      date: "2024-06-10T12:00:00Z",
      url: "https://example.com",
    });
    expect(text).toContain("abc1234");
    expect(text).toContain("2024-06-10");
    expect(text).toContain("fix: handle edge case");
    expect(text).toContain("dev1");
  });
});

describe("formatCommits", () => {
  it("formats commit list with header", () => {
    const text = formatCommits("@zk-kit/lean-imt", [
      { sha: "abc", message: "fix", author: "dev", date: "2024-01-01T00:00:00Z", url: "https://example.com" },
    ]);
    expect(text).toContain("Recent commits for @zk-kit/lean-imt");
    expect(text).toContain("abc");
  });

  it("returns no-commits message when empty", () => {
    const text = formatCommits("@zk-kit/lean-imt", []);
    expect(text).toContain("No recent commits found");
  });
});

// --- fetchPackageDownloads ---

describe("fetchPackageDownloads", () => {
  it("fetches npm weekly and monthly downloads", async () => {
    // weekly
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ downloads: 1234 }),
    });
    // monthly
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ downloads: 5678 }),
    });

    const result = await fetchPackageDownloads("@zk-kit/lean-imt", "typescript");
    expect(result.source).toBe("npm");
    expect(result.weeklyDownloads).toBe(1234);
    expect(result.monthlyDownloads).toBe(5678);
  });

  it("fetches crates.io downloads for rust", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ crate: { recent_downloads: 999 } }),
    });

    const result = await fetchPackageDownloads("zk-kit-lean-imt", "rust");
    expect(result.source).toBe("crates.io");
    expect(result.monthlyDownloads).toBe(999);
    expect(result.weeklyDownloads).toBe(0);
  });

  it("returns unavailable for noir", async () => {
    const result = await fetchPackageDownloads("lean_imt", "noir");
    expect(result.source).toBe("unavailable");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("handles npm API failure gracefully", async () => {
    mockFetch.mockRejectedValueOnce(new Error("Network error"));

    const result = await fetchPackageDownloads("@zk-kit/lean-imt", "typescript");
    expect(result.source).toBe("npm");
    expect(result.weeklyDownloads).toBe(0);
    expect(result.monthlyDownloads).toBe(0);
  });

  it("handles crates.io API failure gracefully", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });

    const result = await fetchPackageDownloads("zk-kit-nonexistent", "rust");
    expect(result.source).toBe("crates.io");
    expect(result.monthlyDownloads).toBe(0);
  });

  it("handles partial npm failure (one endpoint fails)", async () => {
    // weekly fails
    mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });
    // monthly succeeds
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ downloads: 3000 }),
    });

    const result = await fetchPackageDownloads("@zk-kit/lean-imt", "circom");
    expect(result.source).toBe("npm");
    expect(result.weeklyDownloads).toBe(0);
    expect(result.monthlyDownloads).toBe(3000);
  });
});

describe("formatPackageDownloads", () => {
  it("formats npm download stats", () => {
    const text = formatPackageDownloads("@zk-kit/lean-imt", {
      weeklyDownloads: 1234,
      monthlyDownloads: 5678,
      source: "npm",
    });
    expect(text).toContain("Download Stats for @zk-kit/lean-imt");
    expect(text).toContain("npm");
    expect(text).toContain("1,234");
    expect(text).toContain("5,678");
    expect(text).toContain("Weekly");
    expect(text).toContain("Monthly");
  });

  it("formats crates.io download stats", () => {
    const text = formatPackageDownloads("zk-kit-lean-imt", {
      weeklyDownloads: 0,
      monthlyDownloads: 999,
      source: "crates.io",
    });
    expect(text).toContain("crates.io");
    expect(text).toContain("Recent Downloads (90d)");
    expect(text).toContain("999");
  });

  it("formats unavailable message", () => {
    const text = formatPackageDownloads("lean_imt", {
      weeklyDownloads: 0,
      monthlyDownloads: 0,
      source: "unavailable",
    });
    expect(text).toContain("not available");
    expect(text).toContain("no package registry");
  });
});

// --- fetchWorkflowRuns ---

describe("fetchWorkflowRuns", () => {
  it("parses workflow runs from GitHub API", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        workflow_runs: [
          {
            name: "CI",
            status: "completed",
            conclusion: "success",
            head_branch: "main",
            created_at: "2024-06-15T12:00:00Z",
            html_url: "https://github.com/zk-kit/zk-kit/actions/runs/123",
          },
          {
            name: "CI",
            status: "completed",
            conclusion: "failure",
            head_branch: "dev",
            created_at: "2024-06-14T10:00:00Z",
            html_url: "https://github.com/zk-kit/zk-kit/actions/runs/122",
          },
        ],
      }),
    });

    const runs = await fetchWorkflowRuns("zk-kit/zk-kit", 5);
    expect(runs).toHaveLength(2);
    expect(runs[0].name).toBe("CI");
    expect(runs[0].conclusion).toBe("success");
    expect(runs[0].branch).toBe("main");
    expect(runs[1].conclusion).toBe("failure");
  });

  it("handles empty runs", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ workflow_runs: [] }),
    });

    const runs = await fetchWorkflowRuns("zk-kit/zk-kit", 5);
    expect(runs).toEqual([]);
  });
});

describe("formatWorkflowRuns", () => {
  it("formats runs with pass/fail status", () => {
    const text = formatWorkflowRuns("zk-kit/zk-kit", [
      {
        name: "CI",
        status: "completed",
        conclusion: "success",
        branch: "main",
        createdAt: "2024-06-15T12:00:00Z",
        url: "https://example.com/1",
      },
      {
        name: "CI",
        status: "completed",
        conclusion: "failure",
        branch: "dev",
        createdAt: "2024-06-14T10:00:00Z",
        url: "https://example.com/2",
      },
    ]);
    expect(text).toContain("CI Status for zk-kit/zk-kit");
    expect(text).toContain("PASS");
    expect(text).toContain("FAIL");
    expect(text).toContain("main");
    expect(text).toContain("dev");
  });

  it("shows in-progress status", () => {
    const text = formatWorkflowRuns("zk-kit/zk-kit", [
      {
        name: "CI",
        status: "in_progress",
        conclusion: null,
        branch: "main",
        createdAt: "2024-06-15T12:00:00Z",
        url: "https://example.com",
      },
    ]);
    expect(text).toContain("IN_PROGRESS");
  });

  it("returns no-runs message for empty", () => {
    const text = formatWorkflowRuns("zk-kit/zk-kit", []);
    expect(text).toContain("No workflow runs found");
  });
});

// --- Retry logic ---

describe("githubFetch retry", () => {
  it("retries on 500 and succeeds on second attempt", async () => {
    // First call: 500
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });
    // Second call: success
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [{ name: "lean-imt", type: "dir" }],
    });

    const dirs = await fetchDirectoryListing("zk-kit/zk-kit", "packages");
    expect(dirs).toEqual(["lean-imt"]);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("does not retry on 404 (client error)", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });

    await expect(fetchDirectoryListing("zk-kit/zk-kit", "packages")).rejects.toThrow("GitHub API 404");
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("does not retry on rate limit (403)", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 403,
      headers: new Headers({
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": "1706000000",
      }),
    });

    await expect(fetchDirectoryListing("zk-kit/zk-kit", "packages")).rejects.toThrow("rate limit");
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("retries on network error and succeeds", async () => {
    // First call: network error
    mockFetch.mockRejectedValueOnce(new Error("fetch failed"));
    // Second call: success
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [{ name: "lean-imt", type: "dir" }],
    });

    const dirs = await fetchDirectoryListing("zk-kit/zk-kit", "packages");
    expect(dirs).toEqual(["lean-imt"]);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});

// --- Per-package release filtering ---

describe("fetchReleases filtering", () => {
  it("filters releases by package name tag prefix", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [
        {
          tag_name: "@zk-kit/lean-imt@1.0.0",
          name: "lean-imt v1.0.0",
          published_at: "2024-01-15T00:00:00Z",
          html_url: "https://example.com/1",
          body: "",
        },
        {
          tag_name: "@zk-kit/poseidon-lite@0.5.0",
          name: "poseidon-lite v0.5.0",
          published_at: "2024-01-10T00:00:00Z",
          html_url: "https://example.com/2",
          body: "",
        },
        {
          tag_name: "@zk-kit/lean-imt@0.9.0",
          name: "lean-imt v0.9.0",
          published_at: "2024-01-05T00:00:00Z",
          html_url: "https://example.com/3",
          body: "",
        },
      ],
    });

    const releases = await fetchReleases("zk-kit/zk-kit", 10, "@zk-kit/lean-imt");
    expect(releases).toHaveLength(2);
    expect(releases[0].tag).toBe("@zk-kit/lean-imt@1.0.0");
    expect(releases[1].tag).toBe("@zk-kit/lean-imt@0.9.0");
  });

  it("returns all releases when no filter provided", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [
        {
          tag_name: "v1.0.0",
          name: "v1.0.0",
          published_at: "2024-01-15T00:00:00Z",
          html_url: "https://example.com",
          body: "",
        },
        {
          tag_name: "v0.9.0",
          name: "v0.9.0",
          published_at: "2024-01-10T00:00:00Z",
          html_url: "https://example.com",
          body: "",
        },
      ],
    });

    const releases = await fetchReleases("zk-kit/zk-kit", 10);
    expect(releases).toHaveLength(2);
  });
});
