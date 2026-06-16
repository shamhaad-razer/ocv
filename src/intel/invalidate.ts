// Finding-level invalidation pass (requirement 9). Pure, host-independent.
//
// Given a stored WorkspaceIntel and a way to read current file hashes, this
// returns a NEW WorkspaceIntel where every finding whose cited source files have
// drifted is marked `potentially-stale` (or `known-stale` on a scanVersion bump)
// and has its confidence recomputed. This is the simple invalidation strategy
// the milestone asks for: mark affected sections stale WITHOUT re-deriving them,
// and never silently serve a finding as fresh when its source moved.
//
// File watching and automatic re-derivation are deliberately out of scope here
// (later milestones). This pass is invoked explicitly (cli `check --write`).

import { invalidateGrounding, recheckFreshness } from "./grounding.js";
import type { Finding, Grounding, RepoIntel, WorkspaceIntel } from "./types.js";
// invalidateGrounding is used both to reground individual findings (via reground)
// and to roll the repo-level status up when any finding drifts.

export type HashResolver = (repo: RepoIntel, ref: string) => string | null;

function reground(g: Grounding, repo: RepoIntel, currentHash: HashResolver): Grounding {
  const res = recheckFreshness(g, (ref) => currentHash(repo, ref));
  return invalidateGrounding(g, res.status, res.staleReason);
}

function regroundFindings<T>(findings: Finding<T>[], repo: RepoIntel, currentHash: HashResolver): Finding<T>[] {
  return findings.map((f) => ({ value: f.value, grounding: reground(f.grounding, repo, currentHash) }));
}

export interface InvalidationSummary {
  repo: string;
  staleFindings: number;
  totalFindings: number;
  repoStatus: Grounding["status"];
}

export interface InvalidationResult {
  workspace: WorkspaceIntel;
  summaries: InvalidationSummary[];
}

function invalidateRepo(repo: RepoIntel, currentHash: HashResolver): { repo: RepoIntel; summary: InvalidationSummary } {
  const importantDirs = regroundFindings(repo.importantDirs, repo, currentHash);
  const packageFiles = regroundFindings(repo.packageFiles, repo, currentHash);
  const scripts = regroundFindings(repo.scripts, repo, currentHash);
  const services = regroundFindings(repo.services, repo, currentHash);
  const routes = regroundFindings(repo.routes, repo, currentHash);
  const envFiles = regroundFindings(repo.envFiles, repo, currentHash);
  const envVars = regroundFindings(repo.envVars, repo, currentHash);
  const deployFiles = regroundFindings(repo.deployFiles, repo, currentHash);
  let grounding = reground(repo.grounding, repo, currentHash);

  const all = [
    ...importantDirs,
    ...packageFiles,
    ...scripts,
    ...services,
    ...routes,
    ...envFiles,
    ...envVars,
    ...deployFiles,
  ];
  const staleFindings = all.filter((f) => f.grounding.status !== "fresh").length;

  // Roll the repo-level status up: if ANY finding drifted, the repo as a whole
  // is at least potentially-stale — saying "fresh" while findings are stale
  // would be dishonest (§11). known-stale (scanVersion) dominates.
  if (grounding.status === "fresh" && staleFindings > 0) {
    const anyKnownStale = all.some((f) => f.grounding.status === "known-stale");
    grounding = invalidateGrounding(
      grounding,
      anyKnownStale ? "known-stale" : "potentially-stale",
      `${staleFindings} finding(s) have drifted sources`,
    );
  }

  return {
    repo: {
      ...repo,
      importantDirs,
      packageFiles,
      scripts,
      services,
      routes,
      envFiles,
      envVars,
      deployFiles,
      grounding,
    },
    summary: {
      repo: repo.name,
      staleFindings,
      totalFindings: all.length,
      repoStatus: grounding.status,
    },
  };
}

export function invalidateWorkspace(ws: WorkspaceIntel, currentHash: HashResolver): InvalidationResult {
  const summaries: InvalidationSummary[] = [];
  const repos = ws.repos.map((repo) => {
    const { repo: updated, summary } = invalidateRepo(repo, currentHash);
    summaries.push(summary);
    return updated;
  });
  return { workspace: { ...ws, repos }, summaries };
}
