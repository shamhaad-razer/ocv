// Grounding helpers: hashing, git introspection, the confidence calculus, and
// freshness checks. Pure and host-independent (only node builtins).
//
// Design refs: 13-freshness-reindexing-confidence.md §1 (Grounding), §3
// (freshness), §5 (confidence calculus). Time is NOT read here — the caller
// (cli.ts) injects `generatedAt` so the pure scan layer stays deterministic
// (mirrors the Prompt 4 note that scan core must not call Date.now()).

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import type {
  AnalysisQuality,
  Confidence,
  ConfidenceBasis,
  FreshnessStatus,
  Grounding,
  SourceRef,
  Verification,
} from "./types.js";

/** Bump this to invalidate all previously-derived intelligence (derive-level stale). */
export const SCAN_VERSION = "0.1.0";

/** Short content hash for source files. Stable, cheap, good enough for drift detection. */
export function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

/** Hash a file's contents; returns null if unreadable (caller records the gap). */
export function hashFile(absPath: string): string | null {
  try {
    return hashContent(readFileSync(absPath, "utf-8"));
  } catch {
    return null;
  }
}

function git(repoRoot: string, args: string[]): string | null {
  try {
    return execFileSync("git", ["-C", repoRoot, ...args], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

export interface GitInfo {
  isGitRepo: boolean;
  branch: string | null;
  commit: string | null;
  /** Working tree state at read time: true=uncommitted changes, false=clean, null=unknown/non-git. */
  dirty: boolean | null;
}

/** Read current branch + short commit + dirty/clean status. Honest about non-git dirs. */
export function readGitInfo(repoRoot: string): GitInfo {
  const inside = git(repoRoot, ["rev-parse", "--is-inside-work-tree"]);
  if (inside !== "true") return { isGitRepo: false, branch: null, commit: null, dirty: null };
  const porcelain = git(repoRoot, ["status", "--porcelain"]);
  return {
    isGitRepo: true,
    branch: git(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]),
    commit: git(repoRoot, ["rev-parse", "--short", "HEAD"]),
    dirty: porcelain === null ? null : porcelain.trim().length > 0,
  };
}

/** One entry from `git status --porcelain`: a changed file + its status code. */
export interface GitChange {
  /** Two-char porcelain status, e.g. " M", "A ", "??", "R ". */
  status: string;
  /** Repo-relative path (rename target if renamed). */
  path: string;
  /** Added/deleted line counts from numstat, when available. */
  added?: number;
  deleted?: number;
}

/**
 * Read the working-tree changes for a repo (git status as source of truth).
 * Returns null for a non-git dir. Includes staged + unstaged + untracked. Pure
 * read — never mutates the tree.
 */
export function readGitChanges(repoRoot: string): GitChange[] | null {
  const inside = git(repoRoot, ["rev-parse", "--is-inside-work-tree"]);
  if (inside !== "true") return null;

  const porcelain = git(repoRoot, ["status", "--porcelain"]);
  if (porcelain === null) return null;

  // Line counts for tracked changes (untracked files won't appear here).
  const numstat = git(repoRoot, ["diff", "--numstat", "HEAD"]) ?? "";
  const counts = new Map<string, { added: number; deleted: number }>();
  for (const line of numstat.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
    if (!m) continue;
    const added = m[1] === "-" ? 0 : parseInt(m[1], 10);
    const deleted = m[2] === "-" ? 0 : parseInt(m[2], 10);
    counts.set(m[3], { added, deleted });
  }

  const changes: GitChange[] = [];
  for (const line of porcelain.split(/\r?\n/)) {
    if (!line.trim()) continue;
    // Porcelain v1: "XY <path>". NOTE the shared git() helper trims the whole
    // output, which can drop a leading space from the FIRST line's status (e.g.
    // " M f" → "M f"). So split on the first run of whitespace rather than fixed
    // columns: everything before the first space-gap is the status code.
    const m = /^(\S{1,2}|\S\s|\s\S)\s+(.*)$/.exec(line);
    let status: string;
    let path: string;
    if (m) {
      status = m[1].padEnd(2, " ").slice(0, 2);
      path = m[2];
    } else {
      // Fallback: treat first 2 chars as status.
      status = line.slice(0, 2);
      path = line.slice(2).trim();
    }
    // Renames look like "old -> new"; keep the new path.
    const arrow = path.indexOf(" -> ");
    if (arrow !== -1) path = path.slice(arrow + 4);
    path = path.replace(/^"(.*)"$/, "$1").trim();
    const c = counts.get(path);
    changes.push({ status, path, added: c?.added, deleted: c?.deleted });
  }
  return changes;
}

/**
 * The single confidence calculus (§5). Confidence is COMPUTED from evidence, not
 * assigned by feel. A finding with no sources can never exceed "low".
 */
export function computeConfidence(basis: ConfidenceBasis): Confidence {
  // Hard floors first — these cap regardless of other inputs.
  if (basis.sourceCoverage === "none") return "low";
  if (basis.missingFiles.length > 0) return "low";
  if (basis.freshness === "known-stale") return "low";
  if (basis.analysisQuality === "heuristic" || basis.analysisQuality === "inferred") {
    // Heuristic/inferred facts are medium at best — unless runtime-verified.
    return basis.runtimeVerification === "verified" ? "high" : "medium";
  }

  // declared / parsed facts:
  const fresh = basis.freshness === "fresh";
  const complete = basis.sourceCoverage === "complete";
  if (fresh && complete) return "high";
  return "medium";
}

/** Convenience: build a ConfidenceBasis for a freshly-scanned, declared fact. */
export function basisForDeclared(opts?: Partial<ConfidenceBasis>): ConfidenceBasis {
  return {
    sourceCoverage: "complete",
    freshness: "fresh",
    analysisQuality: "declared",
    runtimeVerification: "none",
    missingFiles: [],
    ...opts,
  };
}

export interface BuildGroundingInput {
  generatedAt: number;
  baseCommit: string | null;
  sources: SourceRef[];
  analysisQuality: AnalysisQuality;
  /** Override coverage / freshness / missing files when the default doesn't fit. */
  basisOverrides?: Partial<ConfidenceBasis>;
  knownUnknownIds?: string[];
  /** Initial status; defaults to "fresh" for a just-completed scan. */
  status?: FreshnessStatus;
  /**
   * Verification level. Defaults to "static". A safe read-only probe that
   * actually ran (e.g. `node --version`) is "runtime-verified" — the only path
   * to high confidence for an inferred/heuristic fact (§5, §7).
   */
  verification?: Verification;
}

/** Assemble a complete Grounding block + computed confidence in one place. */
export function buildGrounding(input: BuildGroundingInput): Grounding {
  const fileHashes = input.sources
    .filter((s) => s.hash && (s.kind === "file" || s.kind === "dir"))
    .map((s) => ({ ref: s.ref, hash: s.hash as string }));

  const verification: Verification = input.verification ?? "static";
  const basis: ConfidenceBasis = {
    sourceCoverage: input.sources.length > 0 ? "complete" : "none",
    freshness: input.status ?? "fresh",
    analysisQuality: input.analysisQuality,
    // A runtime-verified probe feeds the calculus so an inferred fact can reach high.
    runtimeVerification: verification === "runtime-verified" ? "verified" : verification === "runtime-failed" ? "failed" : "none",
    missingFiles: [],
    ...input.basisOverrides,
  };

  return {
    scanVersion: SCAN_VERSION,
    generatedAt: input.generatedAt,
    sources: input.sources,
    baseCommit: input.baseCommit,
    fileHashes,
    status: input.status ?? "fresh",
    confidence: computeConfidence(basis),
    confidenceBasis: basis,
    verification,
    knownUnknownIds: input.knownUnknownIds ?? [],
  };
}

/**
 * Freshness re-check (§3, supports `scan:check`). Given a stored Grounding and a
 * resolver that returns current file hashes, decide if it has drifted. This is
 * the foundation for incremental re-indexing — we can tell WHAT changed without
 * re-deriving everything.
 */
export function recheckFreshness(
  grounding: Grounding,
  currentHash: (ref: string) => string | null,
): { status: FreshnessStatus; staleReason?: string } {
  if (grounding.scanVersion !== SCAN_VERSION) {
    return { status: "known-stale", staleReason: `scanVersion changed (${grounding.scanVersion} → ${SCAN_VERSION})` };
  }
  for (const { ref, hash } of grounding.fileHashes) {
    const now = currentHash(ref);
    if (now === null) {
      return { status: "potentially-stale", staleReason: `source no longer readable: ${ref}` };
    }
    if (now !== hash) {
      return { status: "potentially-stale", staleReason: `source changed: ${ref}` };
    }
  }
  return { status: "fresh" };
}

/**
 * Invalidation primitive (§3, requirement 9). Returns a NEW grounding with the
 * given freshness status written in AND confidence recomputed — because
 * freshness is an input to the confidence calculus, a stale finding must also
 * drop confidence. Pure: takes the resolved status, doesn't read the filesystem.
 */
export function invalidateGrounding(
  grounding: Grounding,
  status: FreshnessStatus,
  staleReason?: string,
): Grounding {
  if (status === "fresh") {
    // Re-freshening: clear the reason and recompute up from current basis.
    const basis: ConfidenceBasis = { ...grounding.confidenceBasis, freshness: "fresh" };
    return {
      ...grounding,
      status,
      staleReason: undefined,
      confidenceBasis: basis,
      confidence: computeConfidence(basis),
    };
  }
  const basis: ConfidenceBasis = { ...grounding.confidenceBasis, freshness: status };
  return {
    ...grounding,
    status,
    staleReason,
    confidenceBasis: basis,
    confidence: computeConfidence(basis),
  };
}
