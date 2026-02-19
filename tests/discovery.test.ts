import { beforeEach, describe, expect, it, vi } from "vitest";
import { discoverAllPackages } from "../src/discovery.js";
import * as github from "../src/github.js";

vi.mock("../src/github.js", () => ({
  fetchDirectoryListing: vi.fn(),
  fetchManifestInfo: vi.fn(),
}));

const mockDirListing = vi.mocked(github.fetchDirectoryListing);
const mockManifest = vi.mocked(github.fetchManifestInfo);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("discoverAllPackages", () => {
  it("discovers packages from all repos", async () => {
    // Mock directory listings for each repo
    mockDirListing
      .mockResolvedValueOnce(["lean-imt", "poseidon-lite"]) // typescript
      .mockResolvedValueOnce(["poseidon-proof"]) // circom
      .mockResolvedValueOnce(["lean-imt"]) // solidity
      .mockResolvedValueOnce(["lean-imt"]) // noir
      .mockResolvedValueOnce(["lean-imt"]); // rust

    mockManifest.mockResolvedValue({ description: "A description", version: "1.0.0", zkKitDependencies: [] });

    const packages = await discoverAllPackages();

    expect(packages.length).toBeGreaterThan(0);
    expect(packages.length).toBe(6); // 2+1+1+1+1
  });

  it("every package has required fields", async () => {
    mockDirListing
      .mockResolvedValueOnce(["lean-imt"])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    mockManifest.mockResolvedValue({ description: "Description", version: "0.1.0", zkKitDependencies: [] });

    const packages = await discoverAllPackages();

    for (const pkg of packages) {
      expect(pkg.name).toBeTruthy();
      expect(pkg.dirName).toBeTruthy();
      expect(pkg.language).toBeTruthy();
      expect(pkg.category).toBeTruthy();
      expect(pkg.repo).toBeTruthy();
      expect(pkg.installCommand).toBeTruthy();
      expect(pkg.crossLanguageId).toBeTruthy();
    }
  });

  it("handles partial repo failures gracefully", async () => {
    mockDirListing
      .mockResolvedValueOnce(["lean-imt"]) // typescript succeeds
      .mockRejectedValueOnce(new Error("Network error")) // circom fails
      .mockResolvedValueOnce(["lean-imt"]) // solidity succeeds
      .mockRejectedValueOnce(new Error("Timeout")) // noir fails
      .mockResolvedValueOnce(["lean-imt"]); // rust succeeds

    mockManifest.mockResolvedValue({ description: "Desc", version: "0.2.0", zkKitDependencies: [] });

    const packages = await discoverAllPackages();

    // Should still return packages from the repos that succeeded
    expect(packages.length).toBe(3);
    expect(packages.map((p) => p.language).sort()).toEqual(["rust", "solidity", "typescript"]);
  });

  it("returns empty array if all repos fail", async () => {
    mockDirListing.mockRejectedValue(new Error("All down"));

    const packages = await discoverAllPackages();
    expect(packages).toEqual([]);
  });

  it("sorts by language order then name", async () => {
    mockDirListing
      .mockResolvedValueOnce(["poseidon-lite", "lean-imt"]) // typescript
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(["lean-imt"]); // rust

    mockManifest.mockResolvedValue({ description: "", zkKitDependencies: [] });

    const packages = await discoverAllPackages();

    // typescript before rust
    expect(packages[0].language).toBe("typescript");
    // within typescript: lean-imt before poseidon-lite (alpha by name)
    expect(packages[0].name).toBe("@zk-kit/lean-imt");
    expect(packages[1].name).toBe("@zk-kit/poseidon-lite");
    expect(packages[2].language).toBe("rust");
  });

  it("survives individual package manifest failures within a repo", async () => {
    mockDirListing
      .mockResolvedValueOnce(["lean-imt", "poseidon-lite", "imt"]) // typescript: 3 packages
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    // First and third succeed, second throws
    mockManifest
      .mockResolvedValueOnce({ description: "Lean IMT description", version: "1.0.0", zkKitDependencies: [] })
      .mockRejectedValueOnce(new Error("Manifest fetch timeout"))
      .mockResolvedValueOnce({ description: "IMT description", version: "0.5.0", zkKitDependencies: [] });

    const packages = await discoverAllPackages();

    // Should get 2 packages (lean-imt and imt), not 0
    expect(packages.length).toBe(2);
    expect(packages.map((p) => p.name)).toContain("@zk-kit/lean-imt");
    expect(packages.map((p) => p.name)).toContain("@zk-kit/imt");
    // poseidon-lite failed but didn't take down the repo
    expect(packages.map((p) => p.name)).not.toContain("@zk-kit/poseidon-lite");
  });

  it("populates version from manifest", async () => {
    mockDirListing
      .mockResolvedValueOnce(["lean-imt"])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    mockManifest.mockResolvedValue({
      description: "Description",
      version: "2.3.4",
      zkKitDependencies: ["poseidon-lite"],
    });

    const packages = await discoverAllPackages();
    expect(packages[0].version).toBe("2.3.4");
  });

  it("populates zkKitDependencies from manifest", async () => {
    mockDirListing
      .mockResolvedValueOnce(["lean-imt"])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    mockManifest.mockResolvedValue({
      description: "Description",
      version: "2.3.4",
      zkKitDependencies: ["poseidon-lite"],
    });

    const packages = await discoverAllPackages();
    expect(packages[0].zkKitDependencies).toEqual(["poseidon-lite"]);
  });

  it("version is undefined when manifest has none", async () => {
    mockDirListing
      .mockResolvedValueOnce(["lean-imt"])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    mockManifest.mockResolvedValue({ description: "Desc", zkKitDependencies: [] });

    const packages = await discoverAllPackages();
    expect(packages[0].version).toBeUndefined();
  });

  it("derives correct names for each language", async () => {
    mockDirListing
      .mockResolvedValueOnce(["lean-imt"]) // typescript
      .mockResolvedValueOnce(["poseidon-proof"]) // circom
      .mockResolvedValueOnce(["excubiae"]) // solidity (override)
      .mockResolvedValueOnce(["lazytower"]) // noir (override)
      .mockResolvedValueOnce(["lean-imt"]); // rust

    mockManifest.mockResolvedValue({ description: "", zkKitDependencies: [] });

    const packages = await discoverAllPackages();
    const names = packages.map((p) => p.name);

    expect(names).toContain("@zk-kit/lean-imt");
    expect(names).toContain("@zk-kit/poseidon-proof.circom");
    expect(names).toContain("@zk-kit/excubiae");
    expect(names).toContain("lazytower");
    expect(names).toContain("zk-kit-lean-imt");
  });
});
