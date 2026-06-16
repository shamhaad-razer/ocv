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
}

/** Read current branch + short commit. Honest about non-git dirs. */
export function readGitInfo(repoRoot: string): GitInfo {
  const inside = git(repoRoot, ["rev-parse", "--is-inside-work-tree"]);
  if (inside !== "true") return { isGitRepo: false, branch: null, commit: null };
  return {
    isGitRepo: true,
    branch: git(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]),
    commit: git(repoRoot, ["rev-parse", "--short", "HEAD"]),
  };
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
}

/** Assemble a complete Grounding block + computed confidence in one place. */
export function buildGrounding(input: BuildGroundingInput): Grounding {
  const fileHashes = input.sources
    .filter((s) => s.hash && (s.kind === "file" || s.kind === "dir"))
    .map((s) => ({ ref: s.ref, hash: s.hash as string }));

  const basis: ConfidenceBasis = {
    sourceCoverage: input.sources.length > 0 ? "complete" : "none",
    freshness: input.status ?? "fresh",
    analysisQuality: input.analysisQuality,
    runtimeVerification: "none",
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
    verification: "static",
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
