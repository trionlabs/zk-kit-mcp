import type {
  CodeSearchResult,
  DirectoryEntry,
  GithubIssue,
  GithubRelease,
  Language,
  PackageCommit,
  PackageDependencies,
  PackageDownloads,
  RepoStats,
  WorkflowRun,
} from "./types.js";

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

function headers(): Record<string, string> {
  const h: Record<string, string> = {
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "zk-kit-mcp",
  };
  if (GITHUB_TOKEN) h.Authorization = `Bearer ${GITHUB_TOKEN}`;
  return h;
}

async function githubFetch(url: string, options?: { accept?: string }): Promise<Response> {
  const h = headers();
  if (options?.accept) h.Accept = options.accept;

  let lastError: Error | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 1000));
    try {
      const resp = await fetch(url, { headers: h, signal: AbortSignal.timeout(15_000) });
      if (!resp.ok) {
        if (resp.status === 403 && resp.headers?.get("x-ratelimit-remaining") === "0") {
          const reset = resp.headers.get("x-ratelimit-reset");
          const resetTimestamp = reset ? parseInt(reset, 10) : NaN;
          const resetTime = Number.isFinite(resetTimestamp) ? new Date(resetTimestamp * 1000).toISOString() : "unknown";
          throw new Error(`GitHub API rate limit exceeded. Resets at ${resetTime}. Set GITHUB_TOKEN for 5000 req/hr.`);
        }
        // Retry on server errors (5xx)
        if (resp.status >= 500 && attempt < 1) {
          lastError = new Error(`GitHub API ${resp.status}: ${url}`);
          continue;
        }
        throw new Error(`GitHub API ${resp.status}: ${url}`);
      }
      return resp;
    } catch (e) {
      // Don't retry rate limit or client errors
      if (e instanceof Error && (e.message.includes("rate limit") || e.message.includes("GitHub API 4"))) {
        throw e;
      }
      lastError = e instanceof Error ? e : new Error(String(e));
      if (attempt < 1) continue;
    }
  }
  throw lastError!;
}

/** Truncate string at word boundary with ellipsis. */
export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  const truncated = s.slice(0, max);
  const lastSpace = truncated.lastIndexOf(" ");
  return `${lastSpace > max * 0.5 ? truncated.slice(0, lastSpace) : truncated}...`;
}

/**
 * Extract a description from README content (HTML or Markdown).
 * Returns empty string if nothing useful can be extracted.
 */
export function extractDescriptionFromReadme(content: string): string {
  // Try HTML: find first <p> with substantial text content (not wrapping other tags)
  const pMatches = content.matchAll(/<p[^>]*>\s*([^<]{10,}?)\s*<\/p>/gi);
  for (const m of pMatches) {
    return truncate(m[1].trim(), 200);
  }

  // Markdown: first non-heading, non-empty, non-HTML line
  const lines = content
    .split("\n")
    .filter((l) => l.trim() && !l.startsWith("#") && !l.startsWith("<") && !l.startsWith("[") && !l.startsWith("!"));
  if (lines.length > 0) return truncate(lines[0].trim(), 200);

  return "";
}

/** List directory names from a GitHub repo path via Contents API. */
export async function fetchDirectoryListing(slug: string, path: string): Promise<string[]> {
  const url = `https://api.github.com/repos/${slug}/contents/${path}`;
  const resp = await githubFetch(url);
  const items = (await resp.json()) as { name: string; type: string }[];
  return items.filter((i) => i.type === "dir").map((i) => i.name);
}

/** Fetch a raw file from GitHub (not API-rate-limited). */
export async function fetchRawFile(slug: string, branch: string, filePath: string): Promise<string | null> {
  const url = `https://raw.githubusercontent.com/${slug}/${branch}/${filePath}`;
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!resp.ok) return null;
    return await resp.text();
  } catch {
    return null;
  }
}

/**
 * Fetch README content from multiple candidate paths.
 * Tries standard path first, falls back to contracts/README.md (Solidity convention).
 * Skips redirect-like files (single line pointing to another file).
 */
async function fetchReadmeContent(
  slug: string,
  branch: string,
  packagePath: string,
  dirName: string,
): Promise<string | null> {
  const candidates = [`${packagePath}/${dirName}/README.md`, `${packagePath}/${dirName}/contracts/README.md`];

  let primaryContent: string | null = null;
  for (let i = 0; i < candidates.length; i++) {
    const content = await fetchRawFile(slug, branch, candidates[i]);
    if (i === 0) primaryContent = content;
    if (content && content.trim().length > 100) return content;
  }

  // Return whatever the primary path gives, even if short
  return primaryContent;
}

export interface ManifestInfo {
  description: string;
  version?: string;
  zkKitDependencies: string[];
}

/** Extract description, version, and internal ZK-Kit dependencies from a package manifest. Falls back to README for description. */
export async function fetchManifestInfo(
  slug: string,
  branch: string,
  packagePath: string,
  dirName: string,
  language: Language,
): Promise<ManifestInfo> {
  let description = "";
  let version: string | undefined;
  let zkKitDependencies: string[] = [];

  if (language === "rust") {
    const content = await fetchRawFile(slug, branch, `${packagePath}/${dirName}/Cargo.toml`);
    if (content) {
      const descMatch = content.match(/description\s*=\s*"([^"]+)"/);
      if (descMatch) description = descMatch[1];
      const verMatch = content.match(/version\s*=\s*"([^"]+)"/);
      if (verMatch) version = verMatch[1];
      // Extract ZK-Kit internal deps
      const deps = parseTomlSection(content, "dependencies");
      zkKitDependencies = Object.keys(deps)
        .filter((k) => k.startsWith("zk-kit-"))
        .map((k) => k.replace("zk-kit-", ""));
    }
  } else if (language !== "noir") {
    // TypeScript, Circom, Solidity use package.json
    const content = await fetchRawFile(slug, branch, `${packagePath}/${dirName}/package.json`);
    if (content) {
      try {
        const pkg = JSON.parse(content);
        description = pkg.description || "";
        if (pkg.version) version = pkg.version;
        // Extract ZK-Kit internal deps
        zkKitDependencies = Object.keys(pkg.dependencies || {})
          .filter((k) => k.startsWith("@zk-kit/"))
          .map((k) => k.replace("@zk-kit/", "").replace(/\.(sol|circom)$/, ""));
      } catch {
        // invalid JSON, fall through to README
      }
    }
  }

  // Fallback: extract from README (handles Noir, Solidity with no description, etc.)
  if (!description) {
    const readme = await fetchReadmeContent(slug, branch, packagePath, dirName);
    if (readme) {
      description = extractDescriptionFromReadme(readme);
    }
  }

  return { description, version, zkKitDependencies };
}

/**
 * Extract the first markdown code block from content.
 * Returns the code block content (without fences) and language hint, or null.
 */
export function extractFirstCodeBlock(content: string): { code: string; language: string } | null {
  const match = content.match(/```(\w*)\n([\s\S]*?)```/);
  if (!match) return null;
  return { language: match[1] || "", code: match[2].trim() };
}

/** Fetch README for a specific package. Tries multiple paths. */
export async function fetchReadme(
  slug: string,
  branch: string,
  packagePath: string,
  dirName: string,
): Promise<string | null> {
  return fetchReadmeContent(slug, branch, packagePath, dirName);
}

/** Fetch recent releases from a GitHub repo. Optionally filter by package name tag prefix. */
export async function fetchReleases(
  repoSlug: string,
  limit: number = 10,
  packageFilter?: string,
): Promise<GithubRelease[]> {
  // Fetch more when filtering since many will be discarded
  const fetchCount = packageFilter ? Math.min(limit * 5, 100) : limit;
  const url = `https://api.github.com/repos/${repoSlug}/releases?per_page=${fetchCount}`;
  const resp = await githubFetch(url);
  const data = (await resp.json()) as {
    tag_name: string;
    name: string;
    published_at: string;
    html_url: string;
    body: string;
  }[];

  let releases = data.map((r) => ({
    tag: r.tag_name,
    name: r.name || r.tag_name,
    date: r.published_at,
    url: r.html_url,
    body: r.body || "",
  }));

  if (packageFilter) {
    const prefix = packageFilter.endsWith("@") ? packageFilter : `${packageFilter}@`;
    releases = releases.filter((r) => r.tag.startsWith(prefix) || r.tag.startsWith(`v${prefix}`));
    releases = releases.slice(0, limit);
  }

  return releases;
}

/** Search issues across ZK-Kit repos. Optionally scope to a specific repo. */
export async function searchIssues(
  query: string,
  state: "open" | "closed" | "all" = "open",
  scopeRepo?: string,
): Promise<GithubIssue[]> {
  let q = scopeRepo ? `${query} repo:${scopeRepo}` : `${query} org:zk-kit`;
  if (state !== "all") q += ` state:${state}`;
  const url = `https://api.github.com/search/issues?q=${encodeURIComponent(q)}&per_page=20`;
  const resp = await githubFetch(url);
  const data = (await resp.json()) as {
    items: {
      number: number;
      title: string;
      state: string;
      html_url: string;
      labels: { name: string }[];
      created_at: string;
    }[];
  };
  return data.items.map((i) => ({
    number: i.number,
    title: i.title,
    state: i.state,
    url: i.html_url,
    labels: i.labels.map((l) => l.name),
    created: i.created_at,
  }));
}

// Package Dependencies

/** Parse a TOML section into key-value pairs. Handles `key = "value"` and `key = { version = "value" }` or `key = { tag = "value" }`. */
function parseTomlSection(content: string, sectionHeader: string): Record<string, string> {
  const deps: Record<string, string> = {};
  const sectionRegex = new RegExp(`^\\[${sectionHeader}\\]\\s*$`, "m");
  const idx = content.search(sectionRegex);
  if (idx === -1) return deps;

  const after = content.slice(idx + content.slice(idx).indexOf("\n") + 1);
  for (const line of after.split("\n")) {
    if (line.startsWith("[")) break; // next section
    // key = { version = "x" } or key = { tag = "x" }
    const mTable = line.match(/^(\S+)\s*=\s*\{.*(?:version|tag)\s*=\s*"([^"]+)"/);
    if (mTable) {
      deps[mTable[1]] = mTable[2];
      continue;
    }
    // key = "value"
    const mSimple = line.match(/^(\S+)\s*=\s*"([^"]+)"/);
    if (mSimple) deps[mSimple[1]] = mSimple[2];
  }
  return deps;
}

export async function fetchPackageDependencies(
  slug: string,
  branch: string,
  packagePath: string,
  dirName: string,
  language: Language,
): Promise<PackageDependencies | null> {
  if (language === "rust") {
    const content = await fetchRawFile(slug, branch, `${packagePath}/${dirName}/Cargo.toml`);
    if (!content) return null;
    return {
      dependencies: parseTomlSection(content, "dependencies"),
      devDependencies: parseTomlSection(content, "dev-dependencies"),
      peerDependencies: {},
    };
  }

  if (language === "noir") {
    const content = await fetchRawFile(slug, branch, `${packagePath}/${dirName}/Nargo.toml`);
    if (!content) return null;
    return {
      dependencies: parseTomlSection(content, "dependencies"),
      devDependencies: {},
      peerDependencies: {},
    };
  }

  // TypeScript, Circom, Solidity use package.json
  const content = await fetchRawFile(slug, branch, `${packagePath}/${dirName}/package.json`);
  if (!content) return null;
  try {
    const pkg = JSON.parse(content);
    return {
      dependencies: pkg.dependencies || {},
      devDependencies: pkg.devDependencies || {},
      peerDependencies: pkg.peerDependencies || {},
    };
  } catch {
    return null;
  }
}

export function formatDependencies(pkgName: string, language: Language, deps: PackageDependencies): string {
  let md = `# Dependencies for ${pkgName} (${language})\n\n`;

  const sections: [string, Record<string, string>][] = [
    ["Dependencies", deps.dependencies],
    ["Dev Dependencies", deps.devDependencies],
    ["Peer Dependencies", deps.peerDependencies],
  ];

  let hasAny = false;
  for (const [title, entries] of sections) {
    const keys = Object.keys(entries);
    if (keys.length === 0) continue;
    hasAny = true;
    md += `## ${title}\n\n`;
    for (const [name, version] of Object.entries(entries)) {
      md += `- \`${name}\`: ${version}\n`;
    }
    md += "\n";
  }

  if (!hasAny) {
    md += "No dependencies found.\n";
  }

  return md;
}

// Repo Stats

export async function fetchRepoStats(slug: string): Promise<RepoStats> {
  const url = `https://api.github.com/repos/${slug}`;
  const resp = await githubFetch(url);
  const data = (await resp.json()) as {
    full_name: string;
    description: string | null;
    stargazers_count: number;
    forks_count: number;
    open_issues_count: number;
    pushed_at: string;
    license: { spdx_id: string } | null;
    topics: string[];
    language: string | null;
    html_url: string;
  };
  return {
    slug: data.full_name,
    description: data.description || "",
    stars: data.stargazers_count,
    forks: data.forks_count,
    openIssues: data.open_issues_count,
    lastPushed: data.pushed_at,
    license: data.license?.spdx_id || "None",
    topics: data.topics || [],
    language: data.language || "Unknown",
    url: data.html_url,
  };
}

export function formatRepoStats(stats: RepoStats): string {
  let md = `## ${stats.slug}\n\n`;
  md += `| Metric | Value |\n|--------|-------|\n`;
  md += `| Stars | ${stats.stars} |\n`;
  md += `| Forks | ${stats.forks} |\n`;
  md += `| Open Issues | ${stats.openIssues} |\n`;
  md += `| Last Pushed | ${stats.lastPushed.slice(0, 10)} |\n`;
  md += `| License | ${stats.license} |\n`;
  md += `| Primary Language | ${stats.language} |\n`;
  md += `| URL | ${stats.url} |\n`;
  if (stats.topics.length > 0) {
    md += `| Topics | ${stats.topics.join(", ")} |\n`;
  }
  if (stats.description) {
    md += `\n${stats.description}\n`;
  }
  return md;
}

// Package Source

export async function fetchDirectoryTree(slug: string, branch: string, path: string): Promise<DirectoryEntry[]> {
  // Use Git Trees API, returns the entire tree in one API call instead of N recursive calls
  const url = `https://api.github.com/repos/${slug}/git/trees/${branch}?recursive=1`;
  const resp = await githubFetch(url);
  const data = (await resp.json()) as {
    tree: { path: string; type: "blob" | "tree"; size?: number }[];
    truncated: boolean;
  };

  const prefix = path.endsWith("/") ? path : `${path}/`;
  const entries: DirectoryEntry[] = [];

  for (const item of data.tree) {
    if (!item.path.startsWith(prefix)) continue;
    const relativePath = item.path.slice(prefix.length);
    if (!relativePath) continue;

    const name = relativePath.split("/").pop()!;
    if (item.type === "blob") {
      entries.push({ name, path: relativePath, type: "file", size: item.size });
    } else if (item.type === "tree") {
      entries.push({ name, path: relativePath, type: "dir" });
    }
  }

  return entries;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

export function formatDirectoryTree(entries: DirectoryEntry[]): string {
  const lines: string[] = [];
  for (const entry of entries) {
    const depth = entry.path.split("/").length - 1;
    const indent = "  ".repeat(depth);
    if (entry.type === "dir") {
      lines.push(`${indent}${entry.name}/`);
    } else {
      const size = entry.size != null ? ` (${formatFileSize(entry.size)})` : "";
      lines.push(`${indent}${entry.name}${size}`);
    }
  }
  return lines.join("\n");
}

export function detectLanguageFromExtension(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase();
  const map: Record<string, string> = {
    ts: "typescript",
    tsx: "typescript",
    js: "javascript",
    jsx: "javascript",
    sol: "solidity",
    nr: "noir",
    rs: "rust",
    toml: "toml",
    json: "json",
    md: "markdown",
    circom: "circom",
    yaml: "yaml",
    yml: "yaml",
  };
  return map[ext || ""] || "";
}

// Code Search

export async function searchCode(
  query: string,
  language?: string,
  scopeRepo?: string,
  scopePath?: string,
): Promise<CodeSearchResult[]> {
  let q = scopeRepo ? `${query} repo:${scopeRepo}` : `${query} org:zk-kit`;
  if (scopePath) q += ` path:${scopePath}`;
  if (language) q += ` language:${language}`;
  const url = `https://api.github.com/search/code?q=${encodeURIComponent(q)}&per_page=20`;
  const resp = await githubFetch(url, { accept: "application/vnd.github.text-match+json" });
  const data = (await resp.json()) as {
    items: {
      name: string;
      path: string;
      repository: { full_name: string };
      html_url: string;
      text_matches?: { fragment: string }[];
    }[];
  };
  return data.items.map((item) => ({
    path: item.path,
    repo: item.repository.full_name,
    url: item.html_url,
    fragment: item.text_matches?.[0]?.fragment || "",
  }));
}

export function formatCodeSearchResults(results: CodeSearchResult[]): string {
  if (results.length === 0) return "No code matches found.";
  return results
    .map((r) => {
      let line = `**${r.repo}** - \`${r.path}\`\n${r.url}`;
      if (r.fragment) {
        const trimmed = r.fragment.trim().slice(0, 200);
        line += `\n\`\`\`\n${trimmed}\n\`\`\``;
      }
      return line;
    })
    .join("\n\n---\n\n");
}

// Package Commits

export async function fetchPackageCommits(slug: string, path: string, limit: number = 10): Promise<PackageCommit[]> {
  const url = `https://api.github.com/repos/${slug}/commits?path=${encodeURIComponent(path)}&per_page=${limit}`;
  const resp = await githubFetch(url);
  const data = (await resp.json()) as {
    sha: string;
    commit: {
      message: string;
      author: { name: string; date: string };
    };
    html_url: string;
  }[];
  return data.map((c) => ({
    sha: c.sha.slice(0, 7),
    message: c.commit.message.split("\n")[0], // first line only
    author: c.commit.author.name,
    date: c.commit.author.date,
    url: c.html_url,
  }));
}

export function formatCommit(c: PackageCommit): string {
  return `\`${c.sha}\` ${c.date.slice(0, 10)} - ${c.message} (${c.author})`;
}

export function formatCommits(pkgName: string, commits: PackageCommit[]): string {
  if (commits.length === 0) return `No recent commits found for ${pkgName}.`;
  let md = `# Recent commits for ${pkgName}\n\n`;
  for (const c of commits) {
    md += `- ${formatCommit(c)}\n`;
  }
  return md;
}

// Package Downloads

function formatNumber(n: number): string {
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export async function fetchPackageDownloads(packageName: string, language: Language): Promise<PackageDownloads> {
  if (language === "noir") {
    return { weeklyDownloads: 0, monthlyDownloads: 0, source: "unavailable" };
  }

  if (language === "rust") {
    try {
      const url = `https://crates.io/api/v1/crates/${packageName}`;
      const resp = await fetch(url, {
        headers: { "User-Agent": "zk-kit-mcp" },
        signal: AbortSignal.timeout(10_000),
      });
      if (!resp.ok) return { weeklyDownloads: 0, monthlyDownloads: 0, source: "crates.io" };
      const data = (await resp.json()) as { crate: { recent_downloads: number } };
      return {
        weeklyDownloads: 0,
        monthlyDownloads: data.crate.recent_downloads || 0,
        source: "crates.io",
      };
    } catch {
      return { weeklyDownloads: 0, monthlyDownloads: 0, source: "crates.io" };
    }
  }

  // npm (TypeScript, Circom, Solidity)
  try {
    const [weekResp, monthResp] = await Promise.all([
      fetch(`https://api.npmjs.org/downloads/point/last-week/${packageName}`, { signal: AbortSignal.timeout(10_000) }),
      fetch(`https://api.npmjs.org/downloads/point/last-month/${packageName}`, { signal: AbortSignal.timeout(10_000) }),
    ]);

    const weekData = weekResp.ok ? ((await weekResp.json()) as { downloads: number }) : { downloads: 0 };
    const monthData = monthResp.ok ? ((await monthResp.json()) as { downloads: number }) : { downloads: 0 };

    return {
      weeklyDownloads: weekData.downloads,
      monthlyDownloads: monthData.downloads,
      source: "npm",
    };
  } catch {
    return { weeklyDownloads: 0, monthlyDownloads: 0, source: "npm" };
  }
}

export function formatPackageDownloads(pkgName: string, downloads: PackageDownloads): string {
  if (downloads.source === "unavailable") {
    return `Download statistics are not available for ${pkgName} (no package registry).`;
  }

  let md = `# Download Stats for ${pkgName}\n\n`;
  md += `| Metric | Value |\n|--------|-------|\n`;
  md += `| Source | ${downloads.source} |\n`;

  if (downloads.source === "npm") {
    md += `| Weekly Downloads | ${formatNumber(downloads.weeklyDownloads)} |\n`;
    md += `| Monthly Downloads | ${formatNumber(downloads.monthlyDownloads)} |\n`;
  } else {
    // crates.io, only has recent (90 day) downloads
    md += `| Recent Downloads (90d) | ${formatNumber(downloads.monthlyDownloads)} |\n`;
  }

  return md;
}

// Build Status (GitHub Actions)

export async function fetchWorkflowRuns(slug: string, limit: number = 5): Promise<WorkflowRun[]> {
  const url = `https://api.github.com/repos/${slug}/actions/runs?per_page=${limit}`;
  const resp = await githubFetch(url);
  const data = (await resp.json()) as {
    workflow_runs: {
      name: string;
      status: string;
      conclusion: string | null;
      head_branch: string;
      created_at: string;
      html_url: string;
    }[];
  };
  return data.workflow_runs.map((r) => ({
    name: r.name,
    status: r.status,
    conclusion: r.conclusion,
    branch: r.head_branch,
    createdAt: r.created_at,
    url: r.html_url,
  }));
}

export function formatWorkflowRuns(slug: string, runs: WorkflowRun[]): string {
  if (runs.length === 0) return `No workflow runs found for ${slug}.`;

  let md = `# CI Status for ${slug}\n\n`;
  for (const run of runs) {
    const icon =
      run.conclusion === "success" ? "PASS" : run.conclusion === "failure" ? "FAIL" : run.status.toUpperCase();
    md += `- **${run.name}** [${icon}] on \`${run.branch}\` (${run.createdAt.slice(0, 10)})\n`;
    md += `  ${run.url}\n`;
  }
  return md;
}

export function formatRelease(r: GithubRelease): string {
  const body = r.body ? `\n${r.body.slice(0, 500)}` : "";
  return `**${r.name}** (${r.date.slice(0, 10)})\n${r.url}${body}`;
}

export function formatIssue(i: GithubIssue): string {
  const labels = i.labels.length ? ` [${i.labels.join(", ")}]` : "";
  return `#${i.number} ${i.title} (${i.state})${labels}\n${i.url}`;
}
