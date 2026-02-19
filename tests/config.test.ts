import { describe, expect, it } from "vitest";
import { deriveCrossLanguageId, deriveInstallCommand, deriveName, inferCategory, REPOS } from "../src/config.js";

describe("REPOS", () => {
  it("has 5 repo configs", () => {
    expect(REPOS).toHaveLength(5);
  });

  it("covers all expected languages", () => {
    const languages = REPOS.map((r) => r.language).sort();
    expect(languages).toEqual(["circom", "noir", "rust", "solidity", "typescript"]);
  });

  it("each repo has required fields", () => {
    for (const repo of REPOS) {
      expect(repo.slug).toBeTruthy();
      expect(repo.language).toBeTruthy();
      expect(repo.packagePath).toBeTruthy();
      expect(repo.branch).toBeTruthy();
    }
  });
});

describe("deriveName", () => {
  it("typescript: scoped @zk-kit/ prefix", () => {
    expect(deriveName("lean-imt", "typescript")).toBe("@zk-kit/lean-imt");
    expect(deriveName("poseidon-lite", "typescript")).toBe("@zk-kit/poseidon-lite");
  });

  it("circom: @zk-kit/ scoped with .circom suffix", () => {
    expect(deriveName("poseidon-proof", "circom")).toBe("@zk-kit/poseidon-proof.circom");
    expect(deriveName("binary-merkle-root", "circom")).toBe("@zk-kit/binary-merkle-root.circom");
  });

  it("solidity: @zk-kit/ scoped with .sol suffix", () => {
    expect(deriveName("lean-imt", "solidity")).toBe("@zk-kit/lean-imt.sol");
  });

  it("solidity: excubiae override (scoped, no .sol suffix)", () => {
    expect(deriveName("excubiae", "solidity")).toBe("@zk-kit/excubiae");
  });

  it("noir: hyphens to underscores (Nargo.toml convention)", () => {
    expect(deriveName("lean-imt", "noir")).toBe("lean_imt");
    expect(deriveName("binary-merkle-root", "noir")).toBe("binary_merkle_root");
    expect(deriveName("lazytower", "noir")).toBe("lazytower");
    expect(deriveName("ecdh", "noir")).toBe("ecdh");
  });

  it("rust: zk-kit- prefix", () => {
    expect(deriveName("lean-imt", "rust")).toBe("zk-kit-lean-imt");
  });
});

describe("deriveInstallCommand", () => {
  it("typescript: npm i @zk-kit/...", () => {
    expect(deriveInstallCommand("@zk-kit/lean-imt", "lean-imt", "typescript", "zk-kit/zk-kit")).toBe(
      "npm i @zk-kit/lean-imt",
    );
  });

  it("circom: npm i {name} (name already scoped)", () => {
    expect(
      deriveInstallCommand("@zk-kit/poseidon-proof.circom", "poseidon-proof", "circom", "zk-kit/zk-kit.circom"),
    ).toBe("npm i @zk-kit/poseidon-proof.circom");
  });

  it("solidity: npm i {name} (name already scoped)", () => {
    expect(deriveInstallCommand("@zk-kit/excubiae", "excubiae", "solidity", "zk-kit/zk-kit.solidity")).toBe(
      "npm i @zk-kit/excubiae",
    );
  });

  it("noir: Nargo.toml dependency", () => {
    const cmd = deriveInstallCommand("lean_imt", "lean-imt", "noir", "zk-kit/zk-kit.noir");
    expect(cmd).toContain("Nargo.toml");
    expect(cmd).toContain("lean_imt");
  });

  it("rust: cargo add", () => {
    expect(deriveInstallCommand("zk-kit-lean-imt", "lean-imt", "rust", "zk-kit/zk-kit.rust")).toBe(
      "cargo add zk-kit-lean-imt",
    );
  });
});

describe("inferCategory", () => {
  it("merkle-trees: imt, lean-imt, lazy-imt", () => {
    expect(inferCategory("lean-imt")).toBe("merkle-trees");
    expect(inferCategory("imt")).toBe("merkle-trees");
    expect(inferCategory("lazy-imt")).toBe("merkle-trees");
  });

  it("merkle-trees: smt (Sparse Merkle Tree)", () => {
    expect(inferCategory("smt")).toBe("merkle-trees");
  });

  it("merkle-trees: pmt (Parametric Merkle Tree)", () => {
    expect(inferCategory("pmt")).toBe("merkle-trees");
  });

  it("merkle-trees: binary-merkle-root, merkle-trees", () => {
    expect(inferCategory("binary-merkle-root")).toBe("merkle-trees");
    expect(inferCategory("merkle-trees")).toBe("merkle-trees");
  });

  it("cryptography: eddsa, ecdh, poseidon, baby-jubjub", () => {
    expect(inferCategory("eddsa-poseidon")).toBe("cryptography");
    expect(inferCategory("ecdh")).toBe("cryptography");
    expect(inferCategory("poseidon-lite")).toBe("cryptography");
    expect(inferCategory("baby-jubjub")).toBe("cryptography");
  });

  it("access-control: excubiae", () => {
    expect(inferCategory("excubiae")).toBe("access-control");
  });

  it("identity: semaphore, rln", () => {
    expect(inferCategory("semaphore")).toBe("identity");
    expect(inferCategory("rln")).toBe("identity");
  });

  it("math: utils, math", () => {
    expect(inferCategory("utils")).toBe("math");
    expect(inferCategory("math")).toBe("math");
  });

  it("other: unknown names", () => {
    expect(inferCategory("lazytower")).toBe("other");
    expect(inferCategory("something-new")).toBe("other");
  });

  it("does not false-match substrings (word boundaries)", () => {
    expect(inferCategory("commitment")).toBe("other"); // "imt" is a substring
    expect(inferCategory("limitation")).toBe("other"); // "imt" is a substring
  });
});

describe("deriveCrossLanguageId", () => {
  it("returns dirName unchanged", () => {
    expect(deriveCrossLanguageId("lean-imt")).toBe("lean-imt");
    expect(deriveCrossLanguageId("excubiae")).toBe("excubiae");
  });
});
