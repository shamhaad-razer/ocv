// CLI entry for the project-intelligence scanner (milestone 1).
//
// This is the EDGE: it injects the wall-clock time (so the pure scan layer stays
// deterministic), discovers sibling repos, scans each, writes a grounded JSON
// index + a human markdown map, and supports `--check` to re-verify freshness of
// a prior scan without re-deriving (foundation for incremental re-indexing).
//
// Usage:
//   node dist-scan/cli.mjs scan   [--root <dir>] [--out <dir>] [--repos a,b,c]
//   node dist-scan/cli.mjs check  [--root <dir>] [--out <dir>] [--no-write]
//   node dist-scan/cli.mjs diff   [--root <dir>] [--out <dir>]
//
// Defaults: root = parent of the repo this CLI lives in (the workspace), repos =
// auto-detected immediate subdirectories that contain a manifest or .git, out =
// <root>/.openclaw.

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { hashFile, SCAN_VERSION } from "./grounding.js";
import { scanRepo } from "./scanner.js";
import { renderWorkspaceMarkdown, renderDiffMarkdown } from "./render.js";
import { compareWorkspaces, hasChanges } from "./compare.js";
import { invalidateWorkspace } from "./invalidate.js";
import {
  buildCommandBook,
  renderCommandBookMarkdown,
  renderOverview,
  renderRepoOnboarding,
} from "./onboarding.js";
import { detectMachineEnv } from "./env.js";
import { explainSelection, listRepoFiles } from "./explain.js";
import { buildChangeReport } from "./change.js";
import { mergeVerificationStores, runVerification } from "./verify.js";
import { renderMachineEnv, renderChangeReportMarkdown } from "./render.js";
import type { ExplainRequest, VerificationStore, WorkspaceIntel } from "./types.js";

interface Args {
  cmd: "scan" | "check" | "diff" | "docs" | "env" | "explain" | "report" | "verify";
  root: string;
  out: string;
  repos?: string[];
  /** check: write invalidated freshness back to the artifact (default true). */
  write: boolean;
  /** env: ports to probe (opt-in, requires the user to pass --check-ports). */
  checkPorts?: number[];
  /** explain: positional target "<repo>/<path>:<startLine>-<endLine>". */
  target?: string;
  /** explain: experience level for the explanation lens. */
  level?: ExplainRequest["experienceLevel"];
  /** verify: explicit command to verify (e.g. "vitest run"). */
  run?: string;
  /** verify: repo the --run command belongs to. */
  runRepo?: string;
  /** verify: explicit user confirmation to run confirm-required checks. */
  confirmed: boolean;
}

function parseArgs(argv: string[]): Args {
  const cmd = (["check", "diff", "docs", "env", "explain", "report", "verify"].includes(argv[0]) ? argv[0] : "scan") as Args["cmd"];
  const flags = new Map<string, string>();
  const bools = new Set<string>();
  const positionals: string[] = [];
  const VALUELESS = new Set(["no-write", "confirm"]);
  for (let i = 1; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      const key = argv[i].slice(2);
      if (VALUELESS.has(key)) {
        bools.add(key);
      } else {
        flags.set(key, argv[i + 1] ?? "");
        i++;
      }
    } else {
      positionals.push(argv[i]);
    }
  }
  // Default workspace root = two levels up from src/intel (i.e. the repo's parent).
  const defaultRoot = resolve(process.cwd(), "..");
  const root = resolve(flags.get("root") ?? defaultRoot);
  const out = resolve(flags.get("out") ?? join(root, ".openclaw"));
  const repos = flags.get("repos")?.split(",").map((s) => s.trim()).filter(Boolean);
  const checkPorts = flags
    .get("check-ports")
    ?.split(",")
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n));
  const level = flags.get("level") as Args["level"] | undefined;
  return {
    cmd,
    root,
    out,
    repos,
    write: !bools.has("no-write"),
    checkPorts,
    target: positionals[0],
    level,
    run: flags.get("run") || undefined,
    runRepo: flags.get("repo") || undefined,
    confirmed: bools.has("confirm"),
  };
}

/** Parse "<repo>/<path>:<startLine>-<endLine>" (or ":<line>") into an ExplainRequest. */
function parseExplainTarget(target: string, level?: ExplainRequest["experienceLevel"]): ExplainRequest | null {
  const m = /^([^/]+)\/(.+):(\d+)(?:-(\d+))?$/.exec(target);
  if (!m) return null;
  const startLine = parseInt(m[3], 10);
  const endLine = m[4] ? parseInt(m[4], 10) : startLine;
  return { repo: m[1], path: m[2], startLine, endLine, experienceLevel: level };
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

async function runScan(args: Args, now: number): Promise<void> {
  const repoNames = args.repos ?? detectRepos(args.root);
  if (repoNames.length === 0) {
    console.error(`[scan] no repos found under ${args.root}`);
    process.exit(1);
  }
  const repos = repoNames.map((name) => scanRepo(join(args.root, name), { generatedAt: now }));

  // Safe local environment detection (read-only probes only; ports NOT checked
  // during scan — that's opt-in via `env --check-ports`).
  const { env, unknowns: envUnknowns } = await detectMachineEnv({ generatedAt: now });

  const ws: WorkspaceIntel = {
    rootPath: args.root,
    scanVersion: SCAN_VERSION,
    generatedAt: now,
    repos,
    machineEnv: env,
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
      ...envUnknowns,
    ],
  };

  mkdirSync(args.out, { recursive: true });
  const jsonPath = join(args.out, "project-intel.json");
  const mdPath = join(args.out, "project-map.md");
  const prevPath = join(args.out, "project-intel.prev.json");

  // Archive the previous scan so `diff` can compare without external storage.
  if (existsSync(jsonPath)) {
    writeFileSync(prevPath, readFileSync(jsonPath, "utf-8"), "utf-8");
  }

  writeFileSync(jsonPath, JSON.stringify(ws, null, 2), "utf-8");
  writeFileSync(mdPath, renderWorkspaceMarkdown(ws), "utf-8");

  const totalUnknowns = repos.reduce((n, r) => n + r.knownUnknowns.length, 0) + ws.knownUnknowns.length;
  console.log(`[scan] scanned ${repos.length} repo(s); ${totalUnknowns} known-unknown(s) recorded`);
  console.log(`[scan] wrote ${jsonPath}`);
  console.log(`[scan] wrote ${mdPath}`);

  // Generate onboarding docs + command book from the same grounded index.
  writeOnboardingDocs(ws, args.out);
}

/** Generate the onboarding artifacts (overview, per-repo, command book) into a docs/ subdir. */
function writeOnboardingDocs(ws: WorkspaceIntel, out: string): void {
  const docsDir = join(out, "docs");
  mkdirSync(docsDir, { recursive: true });

  writeFileSync(join(docsDir, "onboarding-overview.md"), renderOverview(ws), "utf-8");
  for (const repo of ws.repos) {
    writeFileSync(join(docsDir, `onboarding-${repo.name}.md`), renderRepoOnboarding(repo), "utf-8");
  }
  const book = buildCommandBook(ws);
  writeFileSync(join(docsDir, "command-book.md"), renderCommandBookMarkdown(book), "utf-8");
  writeFileSync(join(docsDir, "command-book.json"), JSON.stringify(book, null, 2), "utf-8");

  console.log(`[docs] wrote ${ws.repos.length + 2} onboarding doc(s) + command book to ${docsDir}`);
}

function runCheck(args: Args): void {
  const jsonPath = join(args.out, "project-intel.json");
  if (!existsSync(jsonPath)) {
    console.error(`[check] no prior scan at ${jsonPath} — run \`scan\` first`);
    process.exit(1);
  }
  const ws = JSON.parse(readFileSync(jsonPath, "utf-8")) as WorkspaceIntel;

  // Finding-level invalidation: re-hash each finding's cited sources and mark
  // the drifted ones potentially-stale (recomputing confidence). This is the
  // simple invalidation strategy — mark, don't re-derive.
  const { workspace: invalidated, summaries } = invalidateWorkspace(ws, (repo, ref) =>
    hashFile(join(repo.rootPath, ref)),
  );

  let driftedRepos = 0;
  for (const s of summaries) {
    if (s.staleFindings > 0 || s.repoStatus !== "fresh") {
      driftedRepos++;
      console.log(`[check] ${s.repo}: ${s.repoStatus} — ${s.staleFindings}/${s.totalFindings} finding(s) potentially stale`);
    } else {
      console.log(`[check] ${s.repo}: fresh`);
    }
  }

  if (args.write) {
    // Persist the invalidated freshness back so downstream readers see it.
    writeFileSync(jsonPath, JSON.stringify(invalidated, null, 2), "utf-8");
    writeFileSync(join(args.out, "project-map.md"), renderWorkspaceMarkdown(invalidated), "utf-8");
    console.log(`[check] wrote invalidated freshness back to ${jsonPath} + project-map.md`);
  } else {
    console.log(`[check] --no-write: not persisting (report only)`);
  }

  console.log(`[check] ${driftedRepos} of ${ws.repos.length} repo(s) have potentially-stale findings.`);
  if (driftedRepos > 0) process.exit(2); // non-zero so CI/scripts can react
}

function runDiff(args: Args): void {
  const jsonPath = join(args.out, "project-intel.json");
  const prevPath = join(args.out, "project-intel.prev.json");
  if (!existsSync(prevPath)) {
    console.error(`[diff] no archived previous scan at ${prevPath} — run \`scan\` at least twice first`);
    process.exit(1);
  }
  if (!existsSync(jsonPath)) {
    console.error(`[diff] no current scan at ${jsonPath} — run \`scan\` first`);
    process.exit(1);
  }
  const prev = JSON.parse(readFileSync(prevPath, "utf-8")) as WorkspaceIntel;
  const next = JSON.parse(readFileSync(jsonPath, "utf-8")) as WorkspaceIntel;
  const diff = compareWorkspaces(prev, next);
  const mdPath = join(args.out, "project-diff.md");
  writeFileSync(mdPath, renderDiffMarkdown(diff), "utf-8");

  const changed = hasChanges(diff);
  for (const r of diff.repoDiffs) {
    const moved = r.commitBefore !== r.commitAfter;
    if (r.deltas.length || r.unknownsOpened.length || r.unknownsResolved.length || moved) {
      console.log(`[diff] ${r.name}: ${r.deltas.length} delta(s)${moved ? `, commit ${r.commitBefore}→${r.commitAfter}` : ""}`);
    }
  }
  console.log(`[diff] ${changed ? "changes detected" : "no changes"}; wrote ${mdPath}`);
}

/** Regenerate onboarding docs from the LAST scan without re-scanning the repos. */
function runDocs(args: Args): void {
  const jsonPath = join(args.out, "project-intel.json");
  if (!existsSync(jsonPath)) {
    console.error(`[docs] no scan at ${jsonPath} — run \`scan\` first`);
    process.exit(1);
  }
  const ws = JSON.parse(readFileSync(jsonPath, "utf-8")) as WorkspaceIntel;
  writeOnboardingDocs(ws, args.out);
}

/**
 * Detect the local machine environment and merge it into the last scan (so
 * onboarding docs gain setup-compatibility notes). Safe probes always run; port
 * checks run ONLY when --check-ports is passed (explicit user confirmation).
 */
async function runEnv(args: Args, now: number): Promise<void> {
  if (args.checkPorts && args.checkPorts.length) {
    console.log(`[env] --check-ports given: probing ports ${args.checkPorts.join(", ")} (local bind test, no network egress)`);
  }
  const { env, unknowns } = await detectMachineEnv({ generatedAt: now, checkPorts: args.checkPorts });
  console.log(renderMachineEnv(env));

  // If a prior scan exists, merge the env into it + regenerate docs so the
  // command book/overview pick up setup compatibility.
  const jsonPath = join(args.out, "project-intel.json");
  if (existsSync(jsonPath)) {
    const ws = JSON.parse(readFileSync(jsonPath, "utf-8")) as WorkspaceIntel;
    ws.machineEnv = env;
    // refresh the env-related workspace unknowns
    ws.knownUnknowns = ws.knownUnknowns.filter((u) => u.kind !== "missing-tool" && u.kind !== "unverified-port").concat(unknowns);
    writeFileSync(jsonPath, JSON.stringify(ws, null, 2), "utf-8");
    writeFileSync(join(args.out, "project-map.md"), renderWorkspaceMarkdown(ws), "utf-8");
    writeOnboardingDocs(ws, args.out);
    console.log(`[env] merged environment into ${jsonPath} + regenerated docs`);
  } else {
    console.log(`[env] no prior scan to merge into — run \`scan\` to persist environment + compatibility`);
  }
}

/**
 * Highlight-to-Explain: resolve a selection into a grounded explanation package
 * and print it as JSON (a future UI consumes this; no UI here). Reads the last
 * scan for index context + the working tree for the selected lines + caller search.
 */
function runExplain(args: Args, now: number): void {
  if (!args.target) {
    console.error('[explain] usage: explain "<repo>/<path>:<startLine>-<endLine>" [--level junior]');
    process.exit(1);
  }
  const req = parseExplainTarget(args.target, args.level);
  if (!req) {
    console.error(`[explain] could not parse target "${args.target}" — expected "<repo>/<path>:<start>-<end>"`);
    process.exit(1);
  }
  const jsonPath = join(args.out, "project-intel.json");
  if (!existsSync(jsonPath)) {
    console.error(`[explain] no scan at ${jsonPath} — run \`scan\` first`);
    process.exit(1);
  }
  const ws = JSON.parse(readFileSync(jsonPath, "utf-8")) as WorkspaceIntel;
  const repo = ws.repos.find((r) => r.name === req.repo);
  const repoFiles = repo ? listRepoFiles(repo.rootPath) : [];
  const pkg = explainSelection(req, ws, { generatedAt: now, repoFiles });
  // Print the structured package for a future frontend; stderr carries a 1-line summary.
  console.error(
    `[explain] ${req.repo}/${req.path}:${req.startLine}-${req.endLine} → confidence=${pkg.confidence}, freshness=${pkg.freshness}${pkg.staleWarning ? " (STALE)" : ""}`,
  );
  process.stdout.write(JSON.stringify(pkg, null, 2) + "\n");
}

/**
 * Change Confidence Report: inspect live git changes across the indexed repos,
 * link them to intel entities, recommend tests, and report risk — WITHOUT
 * claiming safety and WITHOUT running tests. Writes change-report.md + .json.
 */
/** Load the persisted verification store if present (used by the change report). */
function loadVerificationStore(out: string): VerificationStore | null {
  const p = join(out, "verification.json");
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf-8")) as VerificationStore;
  } catch {
    return null;
  }
}

function runReport(args: Args, now: number): void {
  const jsonPath = join(args.out, "project-intel.json");
  if (!existsSync(jsonPath)) {
    console.error(`[report] no scan at ${jsonPath} — run \`scan\` first (the report links changes to the index)`);
    process.exit(1);
  }
  const ws = JSON.parse(readFileSync(jsonPath, "utf-8")) as WorkspaceIntel;
  // Fold in any prior verification results so the report reflects runtime evidence.
  const verification = loadVerificationStore(args.out);
  const report = buildChangeReport(ws, { generatedAt: now, verification });

  const mdPath = join(args.out, "change-report.md");
  const reportJson = join(args.out, "change-report.json");
  writeFileSync(mdPath, renderChangeReportMarkdown(report), "utf-8");
  writeFileSync(reportJson, JSON.stringify(report, null, 2), "utf-8");

  for (const r of report.repos) {
    if (r.summary.total > 0) console.log(`[report] ${r.repo}: ${r.summary.total} changed file(s), ${r.recommendedCommands.length} recommended command(s)`);
  }
  if (verification) console.log(`[report] folded in ${verification.results.length} prior verification result(s)`);
  console.log(`[report] ${report.verdict}`);
  console.log(`[report] wrote ${mdPath} + ${reportJson}`);
}

/**
 * Safe Runtime Verification: run the safe-auto suite (tool versions, deps,
 * env-file existence) always; run an explicit --run command ONLY if its
 * classification allows it (safe-auto runs; confirm-required needs --confirm;
 * blocked is refused). Results are merged into verification.json.
 */
async function runVerify(args: Args, now: number): Promise<void> {
  const jsonPath = join(args.out, "project-intel.json");
  if (!existsSync(jsonPath)) {
    console.error(`[verify] no scan at ${jsonPath} — run \`scan\` first`);
    process.exit(1);
  }
  const ws = JSON.parse(readFileSync(jsonPath, "utf-8")) as WorkspaceIntel;

  const runCommand = args.run ? { repo: args.runRepo ?? ws.repos[0]?.name ?? "", command: args.run } : undefined;
  if (runCommand && !args.runRepo) {
    console.log(`[verify] no --repo given; assuming \`${runCommand.repo}\``);
  }

  const store = await runVerification(ws, { generatedAt: now, runCommand, confirmed: args.confirmed });

  // Merge onto any prior store so accumulated evidence persists.
  const prev = loadVerificationStore(args.out);
  const merged = mergeVerificationStores(prev, store);
  mkdirSync(args.out, { recursive: true });
  writeFileSync(join(args.out, "verification.json"), JSON.stringify(merged, null, 2), "utf-8");

  // Report what happened, classification-first (transparency).
  for (const r of store.results) {
    const tag = r.status === "ran" ? (r.passed === true ? "PASS" : r.passed === false ? "FAIL" : "UNKNOWN") : r.status.toUpperCase();
    console.log(`[verify] [${r.classification}] ${r.label}: ${tag}${r.exitCode != null ? ` (exit ${r.exitCode})` : ""}`);
  }
  const blocked = store.results.filter((r) => r.status === "blocked");
  const skipped = store.results.filter((r) => r.status === "skipped");
  if (blocked.length) console.log(`[verify] ${blocked.length} check(s) BLOCKED (destructive/installing/long-running) — never run.`);
  if (skipped.length) console.log(`[verify] ${skipped.length} check(s) skipped — re-run with --confirm to execute confirm-required checks.`);
  console.log(`[verify] wrote ${join(args.out, "verification.json")} (${merged.results.length} total result(s))`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const now = Date.now(); // injected here at the edge ONLY
  if (args.cmd === "check") runCheck(args);
  else if (args.cmd === "diff") runDiff(args);
  else if (args.cmd === "docs") runDocs(args);
  else if (args.cmd === "env") await runEnv(args, now);
  else if (args.cmd === "explain") runExplain(args, now);
  else if (args.cmd === "report") runReport(args, now);
  else if (args.cmd === "verify") await runVerify(args, now);
  else await runScan(args, now);
}

main();
