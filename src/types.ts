import { z } from "zod";

export const Language = z.enum(["typescript", "circom", "solidity", "noir", "rust"]);
export type Language = z.infer<typeof Language>;

export const Category = z.enum(["merkle-trees", "cryptography", "identity", "access-control", "math", "other"]);
export type Category = z.infer<typeof Category>;

export interface RepoConfig {
  slug: string;
  language: Language;
  packagePath: string;
  branch: string;
}

export interface Package {
  name: string;
  dirName: string;
  language: Language;
  category: Category;
  repo: string;
  description: string;
  installCommand: string;
  crossLanguageId: string;
  version?: string;
  zkKitDependencies: string[];
}

export interface PackageDependencies {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  peerDependencies: Record<string, string>;
}

export interface RepoStats {
  slug: string;
  description: string;
  stars: number;
  forks: number;
  openIssues: number;
  lastPushed: string;
  license: string;
  topics: string[];
  language: string;
  url: string;
}

export interface DirectoryEntry {
  name: string;
  path: string;
  type: "file" | "dir";
  size?: number;
}

export interface CodeSearchResult {
  path: string;
  repo: string;
  url: string;
  fragment: string;
}

export interface PackageCommit {
  sha: string;
  message: string;
  author: string;
  date: string;
  url: string;
}

export interface PackageDownloads {
  weeklyDownloads: number;
  monthlyDownloads: number;
  source: "npm" | "crates.io" | "unavailable";
}

export interface WorkflowRun {
  name: string;
  status: string;
  conclusion: string | null;
  branch: string;
  createdAt: string;
  url: string;
}

export interface GithubRelease {
  tag: string;
  name: string;
  date: string;
  url: string;
  body: string;
}

export interface GithubIssue {
  number: number;
  title: string;
  state: string;
  url: string;
  labels: string[];
  created: string;
}
