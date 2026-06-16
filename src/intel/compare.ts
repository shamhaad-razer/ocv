// Scan-to-scan comparison (requirement 8). Pure, host-independent.
//
// Compares a previous WorkspaceIntel to a current one and reports what changed:
// added/removed/changed findings per section, commit/branch transitions, and
// which known-unknowns opened or resolved. This is the read-only sibling of the
// invalidation pass (invalidate.ts) — it explains *what moved*, it does not
// mutate state.

import type {
  Finding,
  FindingDelta,
  RepoDiff,
  RepoIntel,
  WorkspaceDiff,
  WorkspaceIntel,
} from "./types.js";

/** Stable key + display string for each comparable section of a repo. */
const SECTIONS: {
  section: string;
  keys: (r: RepoIntel) => Map<string, string>;
}[] = [
  {
    section: "packageFiles",
    keys: (r) => indexBy(r.packageFiles, (f) => f.value, (f) => f.value),
  },
  {
    section: "scripts",
    keys: (r) => indexBy(r.scripts, (f) => f.value.name, (f) => f.value.command),
  },
  {
    section: "services",
    keys: (r) => indexBy(r.services, (f) => f.value.name, (f) => `${f.value.kind}@${f.value.evidence}`),
  },
  {
    section: "routes",
    keys: (r) => indexBy(r.routes, (f) => `${f.value.method} ${f.value.pathPattern}`, (f) => f.value.locator),
  },
  {
    section: "envVars",
    keys: (r) => indexBy(r.envVars, (f) => f.value.name, (f) => f.value.source),
  },
  {
    section: "deployFiles",
    keys: (r) => indexBy(r.deployFiles, (f) => f.value, (f) => f.value),
  },
];

function indexBy<T>(
  findings: Finding<T>[],
  key: (f: Finding<T>) => string,
  display: (f: Finding<T>) => string,
): Map<string, string> {
  const m = new Map<string, string>();
  for (const f of findings) m.set(key(f), display(f));
  return m;
}

function diffSection(section: string, before: Map<string, string>, after: Map<string, string>): FindingDelta[] {
  const deltas: FindingDelta[] = [];
  for (const [key, val] of after) {
    if (!before.has(key)) {
      deltas.push({ key, section, change: "added", after: val });
    } else if (before.get(key) !== val) {
      deltas.push({ key, section, change: "changed", before: before.get(key), after: val });
    }
  }
  for (const [key, val] of before) {
    if (!after.has(key)) deltas.push({ key, section, change: "removed", before: val });
  }
  return deltas;
}

function diffRepo(prev: RepoIntel, next: RepoIntel): RepoDiff {
  const deltas: FindingDelta[] = [];
  for (const { section, keys } of SECTIONS) {
    deltas.push(...diffSection(section, keys(prev), keys(next)));
  }
  const prevUnknowns = new Set(prev.knownUnknowns.map((u) => u.id));
  const nextUnknowns = new Set(next.knownUnknowns.map((u) => u.id));
  const unknownsOpened = [...nextUnknowns].filter((id) => !prevUnknowns.has(id));
  const unknownsResolved = [...prevUnknowns].filter((id) => !nextUnknowns.has(id));

  return {
    name: next.name,
    commitBefore: prev.gitCommit,
    commitAfter: next.gitCommit,
    branchBefore: prev.gitBranch,
    branchAfter: next.gitBranch,
    deltas,
    unknownsOpened,
    unknownsResolved,
  };
}

export function compareWorkspaces(prev: WorkspaceIntel, next: WorkspaceIntel): WorkspaceDiff {
  const prevByName = new Map(prev.repos.map((r) => [r.name, r]));
  const nextByName = new Map(next.repos.map((r) => [r.name, r]));

  const reposAdded = next.repos.filter((r) => !prevByName.has(r.name)).map((r) => r.name);
  const reposRemoved = prev.repos.filter((r) => !nextByName.has(r.name)).map((r) => r.name);

  const repoDiffs: RepoDiff[] = [];
  for (const nextRepo of next.repos) {
    const prevRepo = prevByName.get(nextRepo.name);
    if (!prevRepo) continue; // added repos are reported separately
    repoDiffs.push(diffRepo(prevRepo, nextRepo));
  }

  return {
    prevGeneratedAt: prev.generatedAt,
    nextGeneratedAt: next.generatedAt,
    reposAdded,
    reposRemoved,
    repoDiffs,
  };
}

/** True if a diff contains any change at all (commit move, delta, or unknown shift). */
export function hasChanges(diff: WorkspaceDiff): boolean {
  if (diff.reposAdded.length || diff.reposRemoved.length) return true;
  return diff.repoDiffs.some(
    (r) =>
      r.deltas.length > 0 ||
      r.unknownsOpened.length > 0 ||
      r.unknownsResolved.length > 0 ||
      r.commitBefore !== r.commitAfter,
  );
}
