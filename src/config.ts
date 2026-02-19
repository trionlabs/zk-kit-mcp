import type { Category, Language, RepoConfig } from "./types.js";

export const REPOS: RepoConfig[] = [
  {
    slug: "zk-kit/zk-kit",
    language: "typescript",
    packagePath: "packages",
    branch: "main",
  },
  {
    slug: "zk-kit/zk-kit.circom",
    language: "circom",
    packagePath: "packages",
    branch: "main",
  },
  {
    slug: "zk-kit/zk-kit.solidity",
    language: "solidity",
    packagePath: "packages",
    branch: "main",
  },
  {
    slug: "zk-kit/zk-kit.noir",
    language: "noir",
    packagePath: "packages",
    branch: "main",
  },
  {
    slug: "zk-kit/zk-kit.rust",
    language: "rust",
    packagePath: "crates",
    branch: "main",
  },
];

const NAME_OVERRIDES: Partial<Record<Language, Record<string, string>>> = {
  solidity: { excubiae: "@zk-kit/excubiae" },
};

export function deriveName(dirName: string, language: Language): string {
  const override = NAME_OVERRIDES[language]?.[dirName];
  if (override) return override;

  switch (language) {
    case "typescript":
      return `@zk-kit/${dirName}`;
    case "circom":
      return `@zk-kit/${dirName}.circom`;
    case "solidity":
      return `@zk-kit/${dirName}.sol`;
    case "noir":
      return dirName.replace(/-/g, "_");
    case "rust":
      return `zk-kit-${dirName}`;
  }
}

export function deriveInstallCommand(name: string, dirName: string, language: Language, slug: string): string {
  switch (language) {
    case "typescript":
    case "circom":
    case "solidity":
      return `npm i ${name}`;
    case "noir":
      return `Add to Nargo.toml: ${name} = { git = "https://github.com/${slug}", tag = "main", directory = "packages/${dirName}" }`;
    case "rust":
      return `cargo add ${name}`;
  }
}

const CATEGORY_RULES: [RegExp, Category][] = [
  [/(?:^|-)(?:imt|merkle|smt|pmt)(?:-|$)/, "merkle-trees"],
  [/(?:^|-)(?:eddsa|ecdh|poseidon|baby-?jubjub)(?:-|$)/, "cryptography"],
  [/(?:^|-)excubiae(?:-|$)/, "access-control"],
  [/(?:^|-)(?:semaphore|rln|identity)(?:-|$)/, "identity"],
  [/(?:^|-)(?:utils|math)(?:-|$)/, "math"],
];

export function inferCategory(dirName: string): Category {
  for (const [pattern, category] of CATEGORY_RULES) {
    if (pattern.test(dirName)) return category;
  }
  return "other";
}

export function deriveCrossLanguageId(dirName: string): string {
  return dirName;
}
