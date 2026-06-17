// Freshness & re-indexing for target projects (prompt 28; 13-...md §2/§3).
// Pure + host-only: compares a stored scan against the target's CURRENT state and
// produces a 4-level verdict, classifies which kinds of files drifted, and maps
// those to the generated artifacts they invalidate. READ-ONLY w.r.t. the target —
// it only hashes/stats files and reads git, never writes into the target.

import type { Confidence, RepoIntel, WorkspaceIntel } from "./types.js";

/** The freshness verdict levels (req #3). */
export type FreshnessVerdict = "fresh" | "possibly-stale" | "stale" | "unknown";

/** Categories of "important files" we detect drift in (req #4). */
export type FileCategory =
  | "manifest"
  | "lockfile"
  | "source"
  | "route"
  | "config"
  | "docker-deploy"
  | "env-example"
  | "readme-docs"
  | "script"
  | "other";

/** Generated artifacts that a category of change can invalidate (req #5). */
export type ArtifactKind =
  | "repo-map"
  | "command-book"
  | "onboarding-docs"
  | "deployment-explanation"
  | "known-flows"
  | "explanation-cache"
  | "confidence-report";

/** Per-repo freshness result. */
export interface RepoFreshness {
  repo: string;
  verdict: FreshnessVerdict;
  reasons: string[];
  /** git commit at scan time vs now. */
  scanCommit: string | null;
  currentCommit: string | null;
  /** dirty at scan vs now. */
  currentDirty: boolean | null;
  /** Cited source files whose content hash drifted since the scan. */
  driftedFiles: { path: string; category: FileCategory }[];
  /** Distinct categories that drifted. */
  driftedCategories: FileCategory[];
  /** Artifacts those categories invalidate. */
  affectedArtifacts: ArtifactKind[];
  /** Confidence impact of the verdict (for honesty surfacing). */
  confidenceImpact: Confidence;
}

export interface WorkspaceFreshness {
  targetPath: string;
  overall: FreshnessVerdict;
  repos: RepoFreshness[];
}

/** Resolver the caller supplies: current content hash of a target-relative file. */
export type CurrentHash = (repoRootPath: string, relPath: string) => string | null;
/** Resolver: current git commit + dirty for a repo root (or nulls). */
export type CurrentGit = (repoRootPath: string) => { commit: string | null; dirty: boolean | null };

/** Classify a file path into an important-file category (req #4). */
export function categorizeFile(rel: string): FileCategory {
  const base = rel.split("/").pop() ?? rel;
  if (/^(package\.json|pyproject\.toml|go\.mod|Cargo\.toml|requirements\.txt|Gemfile|composer\.json)$/.test(base)) return "manifest";
  if (/(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|uv\.lock|poetry\.lock|Cargo\.lock|go\.sum|Gemfile\.lock|composer\.lock)$/.test(base)) return "lockfile";
  if (/(^Dockerfile$|^docker-compose.*\.ya?ml$|bitbucket-pipelines\.ya?ml$|\.gitlab-ci\.ya?ml$)/.test(base) || /(^|\/)cicd\//.test(rel) || /(^|\/)\.github\/workflows\//.test(rel)) return "docker-deploy";
  if (/^\.env(\.(example|template))?$/.test(base)) return "env-example";
  if (/^(readme|README)(\.md|\.txt|\.rst)?$/.test(base) || /(^|\/)docs\//.test(rel)) return "readme-docs";
  if (/(^Makefile$|^Justfile$|^Taskfile.*)/.test(base) || /\.sh$/.test(base)) return "script";
  if (/(config|\.ya?ml$|\.toml$|\.ini$|\.cfg$|tsconfig.*\.json$|\.eslintrc|next\.config\.)/.test(base)) return "config";
  if (/\.(ts|tsx|js|mjs|py|go|rs|java|rb)$/.test(base)) return "source"; // route-vs-source refined by caller using the index
  return "other";
}

/** Map a drifted category to the artifacts it can invalidate (req #5). */
export function affectedArtifactsFor(categories: FileCategory[]): ArtifactKind[] {
  const out = new Set<ArtifactKind>();
  for (const c of categories) {
    switch (c) {
      case "manifest":
        out.add("command-book"); out.add("repo-map"); out.add("onboarding-docs"); break;
      case "lockfile":
        out.add("command-book"); break;
      case "source":
      case "route":
        out.add("repo-map"); out.add("known-flows"); out.add("explanation-cache"); out.add("confidence-report"); break;
      case "config":
        out.add("repo-map"); out.add("onboarding-docs"); break;
      case "docker-deploy":
        out.add("deployment-explanation"); out.add("onboarding-docs"); break;
      case "env-example":
        out.add("onboarding-docs"); out.add("deployment-explanation"); break;
      case "readme-docs":
        out.add("onboarding-docs"); break;
      case "script":
        out.add("command-book"); out.add("onboarding-docs"); break;
      case "other":
        out.add("repo-map"); break;
    }
  }
  return [...out];
}

/** Collect every cited source file (with its recorded hash) across a repo's findings. */
function collectFileHashes(repo: RepoIntel): { ref: string; hash: string }[] {
  const seen = new Map<string, string>();
  const add = (fh: { ref: string; hash: string }[]) => fh.forEach((h) => { if (!seen.has(h.ref)) seen.set(h.ref, h.hash); });
  add(repo.grounding.fileHashes);
  const arrays = [repo.packageFiles, repo.docFiles, repo.scripts, repo.services, repo.routes, repo.envFiles, repo.deployFiles, repo.envVars, repo.importantDirs];
  for (const arr of arrays) for (const f of arr) add(f.grounding.fileHashes);
  return [...seen].map(([ref, hash]) => ({ ref, hash }));
}

/** Is a path one the index detected as a route file? (refines source→route) */
function routeFiles(repo: RepoIntel): Set<string> {
  return new Set(repo.routes.map((r) => r.value.locator.split(":")[0]));
}

function repoFreshness(repo: RepoIntel, currentHash: CurrentHash, currentGit: CurrentGit): RepoFreshness {
  const reasons: string[] = [];
  const driftedFiles: { path: string; category: FileCategory }[] = [];

  // --- git signals ---
  const scanCommit = repo.gitCommit;
  const { commit: currentCommit, dirty: currentDirty } = repo.isGitRepo ? currentGit(repo.rootPath) : { commit: null, dirty: null };
  const commitMoved = repo.isGitRepo && scanCommit != null && currentCommit != null && scanCommit !== currentCommit;
  const gitUnknown = !repo.isGitRepo || currentCommit == null;

  // --- file-hash drift over cited sources ---
  const routes = routeFiles(repo);
  for (const { ref, hash } of collectFileHashes(repo)) {
    const now = currentHash(repo.rootPath, ref);
    if (now === null) {
      const cat = categorizeFile(ref);
      driftedFiles.push({ path: ref, category: cat });
      reasons.push(`source no longer readable: ${ref}`);
    } else if (now !== hash) {
      let cat = categorizeFile(ref);
      if (cat === "source" && routes.has(ref)) cat = "route";
      driftedFiles.push({ path: ref, category: cat });
    }
  }
  const driftedCategories = [...new Set(driftedFiles.map((d) => d.category))];

  // --- verdict (req #3): combine the signals, honest about unknowns ---
  let verdict: FreshnessVerdict;
  if (driftedFiles.length > 0) {
    verdict = "stale"; // a cited source actually changed → stored intel is stale
    reasons.unshift(`${driftedFiles.length} indexed file(s) changed (${driftedCategories.join(", ")})`);
  } else if (commitMoved) {
    verdict = "possibly-stale"; // HEAD moved but no INDEXED file changed (other files may have)
    reasons.unshift(`git commit moved ${scanCommit} → ${currentCommit} (no indexed file changed, but others may have)`);
  } else if (currentDirty) {
    verdict = "possibly-stale"; // uncommitted edits present; may not touch indexed files
    reasons.unshift("working tree has uncommitted changes since scan");
  } else if (gitUnknown && repo.isGitRepo) {
    verdict = "unknown";
    reasons.unshift("could not read current git state");
  } else {
    verdict = "fresh";
    reasons.unshift(repo.isGitRepo ? `at scan commit ${scanCommit ?? "?"}, no indexed file changed` : "no indexed file changed (non-git target)");
  }

  const affectedArtifacts = verdict === "fresh" ? [] : affectedArtifactsFor(driftedCategories.length ? driftedCategories : ["other"]);
  const confidenceImpact: Confidence = verdict === "stale" ? "high" : verdict === "possibly-stale" ? "medium" : "low";

  return {
    repo: repo.name,
    verdict,
    reasons,
    scanCommit,
    currentCommit,
    currentDirty,
    driftedFiles,
    driftedCategories,
    affectedArtifacts,
    confidenceImpact,
  };
}

const ORDER: Record<FreshnessVerdict, number> = { fresh: 0, unknown: 1, "possibly-stale": 2, stale: 3 };

/** Compute freshness for a whole stored scan vs. the target's current state. */
export function computeFreshness(ws: WorkspaceIntel, currentHash: CurrentHash, currentGit: CurrentGit): WorkspaceFreshness {
  const repos = ws.repos.map((r) => repoFreshness(r, currentHash, currentGit));
  // overall = worst repo verdict.
  const overall = repos.reduce<FreshnessVerdict>((worst, r) => (ORDER[r.verdict] > ORDER[worst] ? r.verdict : worst), "fresh");
  return { targetPath: ws.targetPath ?? ws.rootPath, overall, repos };
}
