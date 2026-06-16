// CLI entry for the project-intelligence scanner (milestone 1).
//
// This is the EDGE: it injects the wall-clock time (so the pure scan layer stays
// deterministic), discovers sibling repos, scans each, writes a grounded JSON
// index + a human markdown map, and supports `--check` to re-verify freshness of
// a prior scan without re-deriving (foundation for incremental re-indexing).
//
// Usage:
//   node dist-scan/cli.mjs scan   [--root <dir>] [--out <dir>] [--repos a,b,c]
//   node dist-scan/cli.mjs check  [--root <dir>] [--out <dir>]
//
// Defaults: root = parent of the repo this CLI lives in (the workspace), repos =
// auto-detected immediate subdirectories that contain a manifest or .git, out =
// <root>/.openclaw.

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { hashFile, recheckFreshness, SCAN_VERSION } from "./grounding.js";
import { scanRepo } from "./scanner.js";
import { renderWorkspaceMarkdown } from "./render.js";
import type { Grounding, RepoIntel, WorkspaceIntel } from "./types.js";

interface Args {
  cmd: "scan" | "check";
  root: string;
  out: string;
  repos?: string[];
}

function parseArgs(argv: string[]): Args {
  const cmd = (argv[0] === "check" ? "check" : "scan") as Args["cmd"];
  const flags = new Map<string, string>();
  for (let i = 1; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      flags.set(argv[i].slice(2), argv[i + 1] ?? "");
      i++;
    }
  }
  // Default workspace root = two levels up from src/intel (i.e. the repo's parent).
  const defaultRoot = resolve(process.cwd(), "..");
  const root = resolve(flags.get("root") ?? defaultRoot);
  const out = resolve(flags.get("out") ?? join(root, ".openclaw"));
  const repos = flags.get("repos")?.split(",").map((s) => s.trim()).filter(Boolean);
  return { cmd, root, out, repos };
}

/** Detect candidate repos: immediate subdirs with a manifest or a .git dir. */
function detectRepos(root: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (name.startsWith(".")) continue;
    const abs = join(root, name);
    try {
      if (!statSync(abs).isDirectory()) continue;
    } catch {
      continue;
    }
    const looksLikeRepo =
      existsSync(join(abs, ".git")) ||
      existsSync(join(abs, "package.json")) ||
      existsSync(join(abs, "pyproject.toml")) ||
      existsSync(join(abs, "go.mod"));
    if (looksLikeRepo) out.push(name);
  }
  return out.sort();
}

function runScan(args: Args, now: number): void {
  const repoNames = args.repos ?? detectRepos(args.root);
  if (repoNames.length === 0) {
    console.error(`[scan] no repos found under ${args.root}`);
    process.exit(1);
  }
  const repos = repoNames.map((name) => scanRepo(join(args.root, name), { generatedAt: now }));

  const ws: WorkspaceIntel = {
    rootPath: args.root,
    scanVersion: SCAN_VERSION,
    generatedAt: now,
    repos,
    knownUnknowns: [
      {
        id: "workspace:cross-repo-edges",
        kind: "shallow-graph",
        title: "cross-repo edges not yet mapped",
        detail:
          "This MVP scans each repo independently. Cross-repo wire links (e.g. shared contracts) are not yet stitched (milestone 4+).",
        evidence: [],
        status: "open",
        confidenceImpact: "medium",
      },
    ],
  };

  mkdirSync(args.out, { recursive: true });
  const jsonPath = join(args.out, "project-intel.json");
  const mdPath = join(args.out, "project-map.md");
  writeFileSync(jsonPath, JSON.stringify(ws, null, 2), "utf-8");
  writeFileSync(mdPath, renderWorkspaceMarkdown(ws), "utf-8");

  const totalUnknowns = repos.reduce((n, r) => n + r.knownUnknowns.length, 0) + ws.knownUnknowns.length;
  console.log(`[scan] scanned ${repos.length} repo(s); ${totalUnknowns} known-unknown(s) recorded`);
  console.log(`[scan] wrote ${jsonPath}`);
  console.log(`[scan] wrote ${mdPath}`);
}

function runCheck(args: Args): void {
  const jsonPath = join(args.out, "project-intel.json");
  if (!existsSync(jsonPath)) {
    console.error(`[check] no prior scan at ${jsonPath} — run \`scan\` first`);
    process.exit(1);
  }
  const ws = JSON.parse(readFileSync(jsonPath, "utf-8")) as WorkspaceIntel;
  let drifted = 0;
  for (const repo of ws.repos) {
    // Re-verify EVERY cited source file across all findings, not just the
    // repo-level manifests — otherwise a change to e.g. a route file would be
    // silently missed (which would be a dishonest "fresh"). Build one combined
    // grounding over the union of all fileHashes recorded for this repo.
    const combined = combinedGrounding(repo);
    const res = recheckFreshness(combined, (ref) => hashFile(join(repo.rootPath, ref)));
    const tag = res.status === "fresh" ? "fresh" : `STALE (${res.staleReason})`;
    console.log(`[check] ${repo.name}: ${tag}`);
    if (res.status !== "fresh") drifted++;
  }
  console.log(`[check] ${drifted} of ${ws.repos.length} repo(s) may be stale.`);
  if (drifted > 0) process.exit(2); // non-zero so CI/scripts can react
}

/** Union every fileHash recorded across a repo's findings into one Grounding. */
function combinedGrounding(repo: RepoIntel): Grounding {
  const seen = new Map<string, string>();
  const collect = (g: Grounding) => {
    for (const fh of g.fileHashes) if (!seen.has(fh.ref)) seen.set(fh.ref, fh.hash);
  };
  collect(repo.grounding);
  const findingArrays = [
    repo.importantDirs,
    repo.packageFiles,
    repo.scripts,
    repo.services,
    repo.routes,
    repo.envFiles,
    repo.envVars,
    repo.deployFiles,
  ];
  for (const arr of findingArrays) for (const f of arr) collect(f.grounding);
  return {
    ...repo.grounding,
    fileHashes: [...seen].map(([ref, hash]) => ({ ref, hash })),
  };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const now = Date.now(); // injected here at the edge ONLY
  if (args.cmd === "check") runCheck(args);
  else runScan(args, now);
}

main();
