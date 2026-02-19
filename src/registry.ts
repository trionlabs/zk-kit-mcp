import { REPOS } from "./config.js";
import type { Category, Language, Package, RepoConfig } from "./types.js";

export class PackageRegistry {
  private packages: Package[] = [];

  load(packages: Package[]): void {
    this.packages = packages;
  }

  get all(): readonly Package[] {
    return this.packages;
  }

  get count(): number {
    return this.packages.length;
  }

  getByName(name: string): Package | undefined {
    const lower = name.toLowerCase();

    // Exact match
    const exact = this.packages.find((p) => p.name.toLowerCase() === lower);
    if (exact) return exact;

    // Match without scope prefix (e.g., "lean-imt" matches "@zk-kit/lean-imt")
    const stripped = this.packages.find((p) => p.name.toLowerCase().replace(/^@zk-kit\//, "") === lower);
    if (stripped) return stripped;

    // Match by dirName
    const byDir = this.packages.find((p) => p.dirName.toLowerCase() === lower);
    if (byDir) return byDir;

    // Normalized match: _ -> -, strip zk-kit- prefix (handles Noir/Rust naming)
    const normalized = lower.replace(/_/g, "-");
    const withoutPrefix = normalized.replace(/^zk-kit-/, "");
    if (normalized !== lower || withoutPrefix !== normalized) {
      const byNormalized = this.packages.find(
        (p) => p.dirName.toLowerCase() === withoutPrefix || p.dirName.toLowerCase() === normalized,
      );
      if (byNormalized) return byNormalized;
    }

    return undefined;
  }

  suggest(name: string, limit: number = 5): Package[] {
    const terms = name.toLowerCase().split(/\s+/).filter(Boolean);
    return this.packages
      .filter((p) => {
        const nameLower = p.name.toLowerCase();
        const dirLower = p.dirName.toLowerCase();
        return terms.every((term) => nameLower.includes(term) || dirLower.includes(term));
      })
      .slice(0, limit);
  }

  search(query?: string, language?: Language, category?: Category): Package[] {
    let results = [...this.packages];

    if (language) {
      results = results.filter((p) => p.language === language);
    }
    if (category) {
      results = results.filter((p) => p.category === category);
    }
    if (query) {
      const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
      results = results
        .map((p) => {
          const nameLower = p.name.toLowerCase();
          const dirLower = p.dirName.toLowerCase();
          const descLower = p.description.toLowerCase();
          let score = 0;
          for (const term of terms) {
            const termScore =
              (nameLower.includes(term) ? 3 : 0) +
              (dirLower.includes(term) ? 2 : 0) +
              (descLower.includes(term) ? 1 : 0);
            if (termScore === 0) return { pkg: p, score: 0 }; // all terms must match somewhere
            score += termScore;
          }
          return { pkg: p, score };
        })
        .filter((r) => r.score > 0)
        .sort((a, b) => b.score - a.score)
        .map((r) => r.pkg);
    }

    return results;
  }

  compare(names: string[]): string {
    const found: Package[] = [];
    const notFound: string[] = [];

    for (const name of names) {
      const pkg = this.getByName(name);
      if (pkg) {
        found.push(pkg);
      } else {
        notFound.push(name);
      }
    }

    if (found.length === 0) {
      return `No packages found for: ${names.join(", ")}`;
    }

    let md = `| Property | ${found.map((p) => p.name).join(" | ")} |\n`;
    md += `|----------|${found.map(() => "---").join("|")}|\n`;
    md += `| Language | ${found.map((p) => p.language).join(" | ")} |\n`;
    md += `| Category | ${found.map((p) => p.category).join(" | ")} |\n`;
    md += `| Version | ${found.map((p) => p.version || "-").join(" | ")} |\n`;
    md += `| Description | ${found.map((p) => p.description || "-").join(" | ")} |\n`;
    md += `| Install | ${found.map((p) => `\`${p.installCommand}\``).join(" | ")} |\n`;
    md += `| Cross-lang ID | ${found.map((p) => p.crossLanguageId).join(" | ")} |\n`;
    md += `| Repo | ${found.map((p) => p.repo).join(" | ")} |\n`;

    if (notFound.length > 0) {
      md += `\n**Not found:** ${notFound.join(", ")}`;
    }

    // Cross-language variants
    const crossIds = [...new Set(found.map((p) => p.crossLanguageId))];
    const variants = this.packages.filter(
      (p) => crossIds.includes(p.crossLanguageId) && !found.some((f) => f.name === p.name),
    );
    if (variants.length > 0) {
      md += "\n\n**Other language variants:**\n";
      for (const v of variants) {
        md += `- ${v.name} (${v.language})\n`;
      }
    }

    return md;
  }

  getEcosystemOverview(): string {
    const byLanguage = new Map<string, Package[]>();
    for (const pkg of this.packages) {
      const list = byLanguage.get(pkg.language) || [];
      list.push(pkg);
      byLanguage.set(pkg.language, list);
    }

    let md = `# ZK-Kit Ecosystem\n\n`;
    md += `**${this.count} packages** across ${byLanguage.size} languages\n\n`;

    for (const [lang, pkgs] of byLanguage) {
      md += `## ${lang} (${pkgs.length} packages)\n\n`;

      const byCategory = new Map<string, Package[]>();
      for (const pkg of pkgs) {
        const list = byCategory.get(pkg.category) || [];
        list.push(pkg);
        byCategory.set(pkg.category, list);
      }

      for (const [cat, catPkgs] of byCategory) {
        md += `### ${cat}\n`;
        for (const p of catPkgs) {
          const ver = p.version ? ` (v${p.version})` : "";
          md += `- **${p.name}**${ver}: ${p.description || "(no description)"}\n`;
        }
        md += "\n";
      }
    }

    // Cross-language summary
    const crossLangGroups = new Map<string, Package[]>();
    for (const pkg of this.packages) {
      const list = crossLangGroups.get(pkg.crossLanguageId) || [];
      list.push(pkg);
      crossLangGroups.set(pkg.crossLanguageId, list);
    }
    const multiLang = [...crossLangGroups.entries()].filter(([, pkgs]) => pkgs.length > 1);
    if (multiLang.length > 0) {
      md += `## Cross-Language Packages\n\n`;
      for (const [id, pkgs] of multiLang) {
        md += `- **${id}**: ${pkgs.map((p) => `${p.language}`).join(", ")}\n`;
      }
    }

    return md;
  }

  getRepoForLanguage(language: Language): RepoConfig | undefined {
    return REPOS.find((r) => r.language === language);
  }

  getCrossLanguageCoverage(): string {
    const languages = [...new Set(this.packages.map((p) => p.language))].sort();
    const conceptMap = new Map<string, Set<string>>();
    for (const pkg of this.packages) {
      const set = conceptMap.get(pkg.crossLanguageId) || new Set();
      set.add(pkg.language);
      conceptMap.set(pkg.crossLanguageId, set);
    }

    const concepts = [...conceptMap.keys()].sort();
    if (concepts.length === 0) return "No packages available.";

    // Build markdown table
    let md = `# Cross-Language Coverage Matrix\n\n`;
    md += `| Concept | ${languages.join(" | ")} |\n`;
    md += `|---------|${languages.map(() => "---").join("|")}|\n`;

    let gapCount = 0;
    const totalSlots = concepts.length * languages.length;
    for (const concept of concepts) {
      const langs = conceptMap.get(concept)!;
      const cells = languages.map((l) => (langs.has(l) ? "yes" : "-"));
      md += `| ${concept} | ${cells.join(" | ")} |\n`;
      gapCount += languages.length - langs.size;
    }

    md += `\n**${concepts.length} concepts** across **${languages.length} languages** - `;
    const coverage = ((1 - gapCount / totalSlots) * 100).toFixed(0);
    md += `**${coverage}% coverage** (${totalSlots - gapCount}/${totalSlots} slots filled)\n`;

    // Highlight multi-language concepts
    const multiLang = concepts.filter((c) => conceptMap.get(c)!.size > 1);
    if (multiLang.length > 0) {
      md += `\n## Multi-Language Concepts\n`;
      for (const c of multiLang) {
        md += `- **${c}**: ${[...conceptMap.get(c)!].join(", ")}\n`;
      }
    }

    // Highlight single-language concepts (gaps)
    const singleLang = concepts.filter((c) => conceptMap.get(c)!.size === 1);
    if (singleLang.length > 0) {
      md += `\n## Single-Language Only (potential gaps)\n`;
      for (const c of singleLang) {
        md += `- **${c}**: ${[...conceptMap.get(c)!].join(", ")} only\n`;
      }
    }

    return md;
  }

  getReverseDependencies(crossLanguageId: string): string {
    // Find all packages that depend on the given concept
    const dependents: { concept: string; languages: string[] }[] = [];
    const directDeps: string[] = [];

    for (const pkg of this.packages) {
      if (pkg.zkKitDependencies.includes(crossLanguageId)) {
        const existing = dependents.find((d) => d.concept === pkg.crossLanguageId);
        if (existing) {
          if (!existing.languages.includes(pkg.language)) existing.languages.push(pkg.language);
        } else {
          dependents.push({ concept: pkg.crossLanguageId, languages: [pkg.language] });
        }
      }
      if (pkg.crossLanguageId === crossLanguageId) {
        for (const dep of pkg.zkKitDependencies) {
          if (!directDeps.includes(dep)) directDeps.push(dep);
        }
      }
    }

    const targetPkgs = this.packages.filter((p) => p.crossLanguageId === crossLanguageId);
    const targetLangs = [...new Set(targetPkgs.map((p) => p.language))];

    let md = `# Dependency Info: ${crossLanguageId}\n\n`;
    md += `**Available in:** ${targetLangs.join(", ")}\n\n`;

    if (directDeps.length > 0) {
      md += `## Depends On\n\n`;
      for (const dep of directDeps.sort()) {
        const depLangs = [...new Set(this.packages.filter((p) => p.crossLanguageId === dep).map((p) => p.language))];
        md += `- **${dep}** (${depLangs.join(", ")})\n`;
      }
      md += "\n";
    }

    if (dependents.length > 0) {
      md += `## Depended On By\n\n`;
      for (const d of dependents.sort((a, b) => a.concept.localeCompare(b.concept))) {
        md += `- **${d.concept}** (${d.languages.join(", ")})\n`;
      }
      md += "\n";
      md += `**${dependents.length} package(s)** depend on ${crossLanguageId}.\n`;
    } else {
      md += `No other ZK-Kit packages depend on ${crossLanguageId}.\n`;
    }

    return md;
  }

  getDependencyGraph(): string {
    if (this.packages.length === 0) return "No packages available.";

    // Build concept-level dependency maps
    const dependsOn = new Map<string, Set<string>>(); // concept -> concepts it depends on
    const dependedBy = new Map<string, Set<string>>(); // concept -> concepts that depend on it
    const allConcepts = new Set<string>();

    for (const pkg of this.packages) {
      const id = pkg.crossLanguageId;
      allConcepts.add(id);
      if (!dependsOn.has(id)) dependsOn.set(id, new Set());

      for (const dep of pkg.zkKitDependencies) {
        dependsOn.get(id)!.add(dep);
        if (!dependedBy.has(dep)) dependedBy.set(dep, new Set());
        dependedBy.get(dep)!.add(id);
        allConcepts.add(dep);
      }
    }

    // Classify concepts
    const foundational: string[] = []; // depended on by others
    const leaf: string[] = []; // depends on others but not depended on
    const independent: string[] = []; // no internal deps in either direction

    for (const concept of [...allConcepts].sort()) {
      const deps = dependsOn.get(concept)?.size ?? 0;
      const usedBy = dependedBy.get(concept)?.size ?? 0;

      if (usedBy > 0) {
        foundational.push(concept);
      } else if (deps > 0) {
        leaf.push(concept);
      } else {
        independent.push(concept);
      }
    }

    let md = `# ZK-Kit Internal Dependency Graph\n\n`;

    // Summary stats
    const totalDeps = [...dependsOn.values()].reduce((sum, s) => sum + s.size, 0);
    md += `**${allConcepts.size} concepts**, **${totalDeps} internal dependencies**\n\n`;

    if (foundational.length > 0) {
      md += `## Foundational Packages\n\nDepended on by other ZK-Kit packages:\n\n`;
      for (const c of foundational) {
        const usedBy = [...(dependedBy.get(c) ?? [])].sort();
        const languages = [...new Set(this.packages.filter((p) => p.crossLanguageId === c).map((p) => p.language))];
        md += `- **${c}** (${languages.join(", ")}): used by ${usedBy.join(", ")}\n`;
      }
      md += "\n";
    }

    if (leaf.length > 0) {
      md += `## Leaf Packages\n\nDepend on other ZK-Kit packages but are not depended on:\n\n`;
      for (const c of leaf) {
        const deps = [...(dependsOn.get(c) ?? [])].sort();
        const languages = [...new Set(this.packages.filter((p) => p.crossLanguageId === c).map((p) => p.language))];
        md += `- **${c}** (${languages.join(", ")}): depends on ${deps.join(", ")}\n`;
      }
      md += "\n";
    }

    if (independent.length > 0) {
      md += `## Independent Packages\n\nNo internal ZK-Kit dependencies:\n\n`;
      for (const c of independent) {
        const languages = [...new Set(this.packages.filter((p) => p.crossLanguageId === c).map((p) => p.language))];
        md += `- **${c}** (${languages.join(", ")})\n`;
      }
    }

    return md;
  }
}
