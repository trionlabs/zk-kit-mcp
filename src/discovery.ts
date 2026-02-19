import { deriveCrossLanguageId, deriveInstallCommand, deriveName, inferCategory, REPOS } from "./config.js";
import { fetchDirectoryListing, fetchManifestInfo } from "./github.js";
import { logger } from "./logger.js";
import type { Package } from "./types.js";

const LANGUAGE_ORDER: Record<string, number> = {
  typescript: 0,
  circom: 1,
  solidity: 2,
  noir: 3,
  rust: 4,
};

export async function discoverAllPackages(): Promise<Package[]> {
  const results = await Promise.allSettled(
    REPOS.map(async (repo) => {
      const dirs = await fetchDirectoryListing(repo.slug, repo.packagePath);
      const settled = await Promise.allSettled(
        dirs.map(async (dirName): Promise<Package> => {
          const name = deriveName(dirName, repo.language);
          const manifest = await fetchManifestInfo(repo.slug, repo.branch, repo.packagePath, dirName, repo.language);
          return {
            name,
            dirName,
            language: repo.language,
            category: inferCategory(dirName),
            repo: `https://github.com/${repo.slug}/tree/${repo.branch}/${repo.packagePath}/${dirName}`,
            description: manifest.description,
            installCommand: deriveInstallCommand(name, dirName, repo.language, repo.slug),
            crossLanguageId: deriveCrossLanguageId(dirName),
            version: manifest.version,
            zkKitDependencies: manifest.zkKitDependencies ?? [],
          };
        }),
      );
      const packages: Package[] = [];
      for (let j = 0; j < settled.length; j++) {
        const s = settled[j];
        if (s.status === "fulfilled") {
          packages.push(s.value);
        } else {
          logger.warn("discovery", `Package "${dirs[j]}" failed`, { language: repo.language, error: String(s.reason) });
        }
      }
      return packages;
    }),
  );

  const allPackages: Package[] = [];
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result.status === "fulfilled") {
      allPackages.push(...result.value);
    } else {
      logger.warn("discovery", `Repo failed`, {
        language: REPOS[i].language,
        slug: REPOS[i].slug,
        error: String(result.reason),
      });
    }
  }

  allPackages.sort((a, b) => {
    const langDiff = (LANGUAGE_ORDER[a.language] ?? 99) - (LANGUAGE_ORDER[b.language] ?? 99);
    if (langDiff !== 0) return langDiff;
    return a.name.localeCompare(b.name);
  });

  return allPackages;
}
