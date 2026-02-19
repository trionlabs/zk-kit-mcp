import { beforeEach, describe, expect, it } from "vitest";
import { PackageRegistry } from "../src/registry.js";
import type { Package } from "../src/types.js";

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

const SYNTHETIC_PACKAGES: Package[] = [
  makePackage({ version: "1.2.3" }),
  makePackage({
    name: "@zk-kit/poseidon-lite",
    dirName: "poseidon-lite",
    category: "cryptography",
    description: "Lightweight Poseidon hash",
    installCommand: "npm i @zk-kit/poseidon-lite",
    crossLanguageId: "poseidon-lite",
  }),
  makePackage({
    name: "@zk-kit/ecdh",
    dirName: "ecdh",
    category: "cryptography",
    description: "ECDH shared secret derivation",
    installCommand: "npm i @zk-kit/ecdh",
    crossLanguageId: "ecdh",
  }),
  makePackage({
    name: "@zk-kit/lean-imt.sol",
    dirName: "lean-imt",
    language: "solidity",
    repo: "https://github.com/zk-kit/zk-kit.solidity/tree/main/packages/lean-imt",
    description: "Lean IMT in Solidity",
    installCommand: "npm i @zk-kit/lean-imt.sol",
    crossLanguageId: "lean-imt",
  }),
  makePackage({
    name: "zk-kit-lean-imt",
    dirName: "lean-imt",
    language: "rust",
    repo: "https://github.com/zk-kit/zk-kit.rust/tree/main/crates/lean-imt",
    description: "Lean IMT in Rust",
    installCommand: "cargo add zk-kit-lean-imt",
    crossLanguageId: "lean-imt",
  }),
  makePackage({
    name: "@zk-kit/excubiae",
    dirName: "excubiae",
    language: "solidity",
    category: "access-control",
    repo: "https://github.com/zk-kit/zk-kit.solidity/tree/main/packages/excubiae",
    description: "Access control for ZK verification",
    installCommand: "npm i @zk-kit/excubiae",
    crossLanguageId: "excubiae",
  }),
];

describe("PackageRegistry", () => {
  let registry: PackageRegistry;

  beforeEach(() => {
    registry = new PackageRegistry();
    registry.load(SYNTHETIC_PACKAGES);
  });

  describe("load / all / count", () => {
    it("loads packages", () => {
      expect(registry.count).toBe(SYNTHETIC_PACKAGES.length);
      expect(registry.all).toEqual(SYNTHETIC_PACKAGES);
    });

    it("search with no filters returns all", () => {
      expect(registry.search().length).toBe(registry.count);
    });
  });

  describe("empty registry", () => {
    it("handles empty load gracefully", () => {
      const empty = new PackageRegistry();
      empty.load([]);
      expect(empty.count).toBe(0);
      expect(empty.all).toEqual([]);
      expect(empty.search()).toEqual([]);
      expect(empty.getByName("anything")).toBeUndefined();
      expect(empty.suggest("anything")).toEqual([]);
    });

    it("compare returns not-found message", () => {
      const empty = new PackageRegistry();
      empty.load([]);
      expect(empty.compare(["a", "b"])).toContain("No packages found");
    });

    it("overview reports 0 packages", () => {
      const empty = new PackageRegistry();
      empty.load([]);
      const md = empty.getEcosystemOverview();
      expect(md).toContain("0 packages");
    });
  });

  describe("getByName", () => {
    it("exact match", () => {
      expect(registry.getByName("@zk-kit/lean-imt")?.name).toBe("@zk-kit/lean-imt");
    });

    it("case-insensitive", () => {
      expect(registry.getByName("@ZK-KIT/LEAN-IMT")?.name).toBe("@zk-kit/lean-imt");
    });

    it("matches without @zk-kit/ scope", () => {
      expect(registry.getByName("lean-imt")?.name).toBe("@zk-kit/lean-imt");
    });

    it("matches by dirName", () => {
      expect(registry.getByName("ecdh")?.name).toBe("@zk-kit/ecdh");
    });

    it("returns undefined for nonexistent", () => {
      expect(registry.getByName("nonexistent")).toBeUndefined();
    });

    it("matches Solidity packages via scope-strip", () => {
      expect(registry.getByName("excubiae")?.language).toBe("solidity");
      expect(registry.getByName("excubiae")?.name).toBe("@zk-kit/excubiae");
    });
  });

  describe("suggest", () => {
    it("suggests matching packages", () => {
      const suggestions = registry.suggest("lean");
      expect(suggestions.length).toBeGreaterThan(0);
      expect(suggestions.every((s) => s.name.includes("lean") || s.dirName.includes("lean"))).toBe(true);
    });

    it("respects limit", () => {
      const suggestions = registry.suggest("lean", 2);
      expect(suggestions.length).toBeLessThanOrEqual(2);
    });

    it("returns empty for no matches", () => {
      expect(registry.suggest("zzzzz")).toEqual([]);
    });

    it("multi-term suggest matches each term independently", () => {
      const suggestions = registry.suggest("lean imt");
      expect(suggestions.length).toBeGreaterThan(0);
      expect(suggestions.every((s) => s.dirName === "lean-imt")).toBe(true);
    });

    it("multi-term suggest requires ALL terms to match", () => {
      expect(registry.suggest("lean nonexistent")).toEqual([]);
    });
  });

  describe("search", () => {
    it("filters by language", () => {
      const results = registry.search(undefined, "solidity");
      expect(results.length).toBeGreaterThan(0);
      expect(results.every((r) => r.language === "solidity")).toBe(true);
    });

    it("filters by category", () => {
      const results = registry.search(undefined, undefined, "cryptography");
      expect(results.length).toBeGreaterThan(0);
      expect(results.every((r) => r.category === "cryptography")).toBe(true);
    });

    it("searches by keyword in name", () => {
      const results = registry.search("lean");
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].dirName).toBe("lean-imt");
    });

    it("searches by keyword in description", () => {
      const results = registry.search("Poseidon");
      expect(results.length).toBeGreaterThan(0);
    });

    it("combines keyword + language filter", () => {
      const results = registry.search("lean", "rust");
      expect(results).toHaveLength(1);
      expect(results[0].language).toBe("rust");
    });

    it("multi-word query matches each term independently", () => {
      // "lean merkle" should match lean-imt because name has "lean" and description has "merkle"
      const results = registry.search("lean merkle");
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].dirName).toBe("lean-imt");
    });

    it("multi-word query requires ALL terms to match", () => {
      // "lean nonexistent" should return nothing because "nonexistent" isn't in any field
      expect(registry.search("lean nonexistent")).toEqual([]);
    });

    it("returns empty for no matches", () => {
      expect(registry.search("nonexistent-xyz")).toEqual([]);
    });

    it("ranks name matches higher than description matches", () => {
      const results = registry.search("ecdh");
      expect(results[0].name).toBe("@zk-kit/ecdh");
    });
  });

  describe("compare", () => {
    it("generates markdown comparison table", () => {
      const md = registry.compare(["@zk-kit/lean-imt", "@zk-kit/lean-imt.sol"]);
      expect(md).toContain("@zk-kit/lean-imt");
      expect(md).toContain("@zk-kit/lean-imt.sol");
      expect(md).toContain("Language");
      expect(md).toContain("typescript");
      expect(md).toContain("solidity");
    });

    it("shows cross-language variants", () => {
      const md = registry.compare(["@zk-kit/lean-imt"]);
      // lean-imt exists in solidity and rust too
      expect(md).toContain("Other language variants");
    });

    it("handles not-found packages", () => {
      const md = registry.compare(["@zk-kit/lean-imt", "nonexistent"]);
      expect(md).toContain("Not found");
      expect(md).toContain("nonexistent");
    });

    it("returns message if all not found", () => {
      const md = registry.compare(["nope1", "nope2"]);
      expect(md).toContain("No packages found");
    });
  });

  describe("getEcosystemOverview", () => {
    it("generates overview markdown", () => {
      const md = registry.getEcosystemOverview();
      expect(md).toContain("ZK-Kit Ecosystem");
      expect(md).toContain(`${SYNTHETIC_PACKAGES.length} packages`);
      expect(md).toContain("typescript");
      expect(md).toContain("solidity");
    });

    it("groups by language and category", () => {
      const md = registry.getEcosystemOverview();
      expect(md).toContain("merkle-trees");
      expect(md).toContain("cryptography");
    });

    it("shows cross-language links", () => {
      const md = registry.getEcosystemOverview();
      expect(md).toContain("Cross-Language Packages");
      expect(md).toContain("lean-imt");
    });
  });

  describe("getRepoForLanguage", () => {
    it("returns repo config for known language", () => {
      const repo = registry.getRepoForLanguage("typescript");
      expect(repo?.slug).toBe("zk-kit/zk-kit");
    });
  });

  describe("version in compare", () => {
    it("shows version row in comparison table", () => {
      const md = registry.compare(["@zk-kit/lean-imt", "@zk-kit/poseidon-lite"]);
      expect(md).toContain("Version");
      expect(md).toContain("1.2.3");
    });

    it("shows - for missing version", () => {
      const md = registry.compare(["@zk-kit/lean-imt.sol"]);
      expect(md).toContain("Version");
      expect(md).toContain("-");
    });
  });

  describe("version in ecosystem overview", () => {
    it("shows version next to package name", () => {
      const md = registry.getEcosystemOverview();
      expect(md).toContain("(v1.2.3)");
    });

    it("omits version suffix when not present", () => {
      const md = registry.getEcosystemOverview();
      // lean-imt.sol has no version, so it should not have a (v...) suffix
      expect(md).toContain("**@zk-kit/lean-imt.sol**:");
    });
  });

  describe("getByName normalized matching", () => {
    it("matches underscore to hyphen (Noir naming)", () => {
      expect(registry.getByName("lean_imt")?.dirName).toBe("lean-imt");
    });

    it("matches with zk-kit- prefix stripped (Rust naming)", () => {
      // "zk-kit-lean-imt" is already an exact match for the Rust package name
      // But "zk-kit-ecdh" is NOT in the registry - test the normalized fallback
      expect(registry.getByName("zk_kit_lean_imt")?.dirName).toBe("lean-imt");
    });

    it("still returns undefined for truly nonexistent names", () => {
      expect(registry.getByName("zzz_nonexistent")).toBeUndefined();
    });
  });

  describe("getCrossLanguageCoverage", () => {
    it("returns markdown table with concepts and languages", () => {
      const md = registry.getCrossLanguageCoverage();
      expect(md).toContain("Cross-Language Coverage Matrix");
      expect(md).toContain("lean-imt");
      expect(md).toContain("typescript");
      expect(md).toContain("solidity");
      expect(md).toContain("rust");
    });

    it("shows yes/- for concept availability", () => {
      const md = registry.getCrossLanguageCoverage();
      // lean-imt is in TS, solidity, rust - has "yes" in those columns
      expect(md).toContain("yes");
      expect(md).toContain("-");
    });

    it("shows coverage percentage", () => {
      const md = registry.getCrossLanguageCoverage();
      expect(md).toMatch(/\d+% coverage/);
    });

    it("lists multi-language concepts", () => {
      const md = registry.getCrossLanguageCoverage();
      expect(md).toContain("Multi-Language Concepts");
      expect(md).toContain("lean-imt");
    });

    it("lists single-language-only concepts", () => {
      const md = registry.getCrossLanguageCoverage();
      expect(md).toContain("Single-Language Only");
      expect(md).toContain("poseidon-lite");
      expect(md).toContain("ecdh");
      expect(md).toContain("excubiae");
    });

    it("returns message for empty registry", () => {
      const empty = new PackageRegistry();
      empty.load([]);
      expect(empty.getCrossLanguageCoverage()).toBe("No packages available.");
    });
  });

  describe("getDependencyGraph", () => {
    it("returns message for empty registry", () => {
      const empty = new PackageRegistry();
      empty.load([]);
      expect(empty.getDependencyGraph()).toBe("No packages available.");
    });

    it("shows foundational packages (depended on by others)", () => {
      const reg = new PackageRegistry();
      reg.load([
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
      const md = reg.getDependencyGraph();
      expect(md).toContain("Foundational Packages");
      expect(md).toContain("poseidon-lite");
      expect(md).toContain("used by lean-imt");
    });

    it("shows leaf packages (depend on others)", () => {
      const reg = new PackageRegistry();
      reg.load([
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
      const md = reg.getDependencyGraph();
      expect(md).toContain("Leaf Packages");
      expect(md).toContain("depends on poseidon-lite");
    });

    it("shows independent packages", () => {
      const md = registry.getDependencyGraph();
      expect(md).toContain("Independent Packages");
    });

    it("shows dependency count summary", () => {
      const reg = new PackageRegistry();
      reg.load([
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
        makePackage({
          name: "@zk-kit/eddsa",
          dirName: "eddsa",
          crossLanguageId: "eddsa",
          zkKitDependencies: ["poseidon-lite"],
        }),
      ]);
      const md = reg.getDependencyGraph();
      expect(md).toContain("3 concepts");
      expect(md).toContain("2 internal dependencies");
    });

    it("all packages independent when no zkKitDependencies", () => {
      const md = registry.getDependencyGraph();
      // SYNTHETIC_PACKAGES all have zkKitDependencies: [] by default
      expect(md).not.toContain("Foundational Packages");
      expect(md).not.toContain("Leaf Packages");
      expect(md).toContain("Independent Packages");
      expect(md).toContain("0 internal dependencies");
    });
  });

  describe("getReverseDependencies", () => {
    it("shows dependents for a foundational package", () => {
      const reg = new PackageRegistry();
      reg.load([
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
        makePackage({
          name: "@zk-kit/eddsa",
          dirName: "eddsa",
          crossLanguageId: "eddsa",
          zkKitDependencies: ["poseidon-lite"],
        }),
      ]);
      const md = reg.getReverseDependencies("poseidon-lite");
      expect(md).toContain("Dependency Info: poseidon-lite");
      expect(md).toContain("Depended On By");
      expect(md).toContain("lean-imt");
      expect(md).toContain("eddsa");
      expect(md).toContain("2 package(s)");
    });

    it("shows forward dependencies for a leaf package", () => {
      const reg = new PackageRegistry();
      reg.load([
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
      const md = reg.getReverseDependencies("lean-imt");
      expect(md).toContain("Depends On");
      expect(md).toContain("poseidon-lite");
    });

    it("shows no dependents for an independent package", () => {
      const md = registry.getReverseDependencies("ecdh");
      expect(md).toContain("No other ZK-Kit packages depend on ecdh");
      expect(md).not.toContain("Depended On By");
    });

    it("shows available languages", () => {
      const md = registry.getReverseDependencies("lean-imt");
      expect(md).toContain("Available in:");
      expect(md).toContain("typescript");
      expect(md).toContain("solidity");
      expect(md).toContain("rust");
    });
  });
});
