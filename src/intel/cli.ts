// CLI entry for the project-intelligence scanner.
//
// This is the EDGE: it injects wall-clock time, scans a TARGET PROJECT, and
// writes a grounded index to HOST storage (NEVER into the target — see
// HOST_VS_TARGET_PROJECT_MODEL.md).
//
// Host vs target (the key distinction, course-corrected in prompt 23):
//   --target <dir>  the EXTERNAL project to study (alias: --root). Read-only.
//   --out <dir>     where OpenClaw writes the index. Defaults to a HOST-side
//                   per-target dir under ~/.openclaw-intel/<hash>, so scanning an
//                   external project NEVER creates files inside it.
//   --repos a,b,c   limit to these subdirs of the target (else auto-detected).
//
// Usage:
//   node dist-scan/cli.mjs scan    --target <dir> [--out <dir>] [--repos a,b,c]
//   node dist-scan/cli.mjs check   --target <dir> [--out <dir>] [--no-write]
//   node dist-scan/cli.mjs diff    --target <dir> [--out <dir>]
//   node dist-scan/cli.mjs report  --target <dir> [--out <dir>]
//   node dist-scan/cli.mjs explain "<repo>/<path>:<a>-<b>" --target <dir>
//   node dist-scan/cli.mjs verify  --target <dir> [--run "<cmd>" --repo <r> --confirm]

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
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
import {
  loadRegistry,
  recordScan,
  removeTarget,
  resolveTarget,
  saveRegistry,
  upsertTarget,
  validateTargetPath,
} from "./registry.js";
import type { ExplainRequest, KnownUnknown, VerificationStore, WorkspaceIntel } from "./types.js";

interface Args {
  cmd: "scan" | "check" | "diff" | "docs" | "env" | "explain" | "report" | "verify" | "targets";
  /** Resolved absolute path of the TARGET PROJECT being studied (read-only). */
  targetPath: string;
  /** Whether the user explicitly supplied --target/--root (vs the legacy default). */
  targetExplicit: boolean;
  /** HOST storage dir for the index — NEVER inside the target project. */
  out: string;
  repos?: string[];
  /** check: write invalidated freshness back to the artifact (default true). */
  write: boolean;
  /** env: ports to probe (opt-in, requires the user to pass --check-ports). */
  checkPorts?: number[];
  /** explain: positional selection "<repo>/<path>:<startLine>-<endLine>". */
  selection?: string;
  /** explain: experience level for the explanation lens. */
  level?: ExplainRequest["experienceLevel"];
  /** verify: explicit command to verify (e.g. "vitest run"). */
  run?: string;
  /** verify: repo the --run command belongs to. */
  runRepo?: string;
  /** verify: explicit user confirmation to run confirm-required checks. */
  confirmed: boolean;
  /** targets: subcommand (add|list|show|remove) — positional[0]. */
  subcmd?: string;
  /** targets: registry ref (id/name/path) — positional[1]. */
  ref?: string;
  /** targets add: display name + description. */
  name?: string;
  desc?: string;
}

/** Stable per-target host storage dir under ~/.openclaw-intel/<name>-<hash>. */
function defaultOutFor(targetPath: string): string {
  const hash = createHash("sha256").update(targetPath).digest("hex").slice(0, 12);
  const name = (targetPath.split("/").filter(Boolean).pop() || "target").replace(/[^A-Za-z0-9_-]/g, "_");
  return join(homedir(), ".openclaw-intel", `${name}-${hash}`);
}

function parseArgs(argv: string[]): Args {
  const cmd = (["check", "diff", "docs", "env", "explain", "report", "verify", "targets"].includes(argv[0]) ? argv[0] : "scan") as Args["cmd"];
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
  // TARGET PROJECT: --target (preferred) or --root (back-compat alias). The value
  // may be an absolute/relative PATH or a registered project ID/displayName — if
  // it's not an existing path, try resolving it against the host registry.
  let targetFlag = flags.get("target") ?? flags.get("root");
  const targetExplicit = targetFlag != null;
  if (targetFlag && !existsSync(targetFlag)) {
    const hit = resolveTarget(loadRegistry(), targetFlag);
    if (hit) targetFlag = hit.targetPath;
  }
  // Default (legacy) is the dir two levels up = the OpenClaw workspace; flagged
  // non-explicit so commands warn.
  const legacyDefault = resolve(process.cwd(), "..");
  const targetPath = resolve(targetFlag ?? legacyDefault);
  // HOST storage: explicit --out wins; otherwise a host-side per-target dir.
  // NEVER default to a path inside the target project (prompt-23 read-only policy).
  const out = resolve(flags.get("out") ?? defaultOutFor(targetPath));
  const repos = flags.get("repos")?.split(",").map((s) => s.trim()).filter(Boolean);
  const checkPorts = flags
    .get("check-ports")
    ?.split(",")
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n));
  const level = flags.get("level") as Args["level"] | undefined;
  return {
    cmd,
    targetPath,
    targetExplicit,
    out,
    repos,
    write: !bools.has("no-write"),
    checkPorts,
    selection: positionals[0],
    level,
    run: flags.get("run") || undefined,
    runRepo: flags.get("repo") || undefined,
    confirmed: bools.has("confirm"),
    subcmd: positionals[0],
    ref: positionals[1],
    name: flags.get("name") || undefined,
    desc: flags.get("desc") || undefined,
  };
}

/**
 * Validate the target project path: must exist and be a directory. Returns an
 * error string (caller exits) or null. This is the guard that keeps OpenClaw
 * from scanning a bogus/typo'd target.
 */
function validateTarget(targetPath: string): string | null {
  if (!existsSync(targetPath)) return `target path does not exist: ${targetPath}`;
  try {
    if (!statSync(targetPath).isDirectory()) return `target path is not a directory: ${targetPath}`;
  } catch (err) {
    return `target path not accessible: ${targetPath} (${(err as Error).message})`;
  }
  return null;
}

/** Parse "<repo>/<path>:<startLine>-<endLine>" (or ":<line>") into an ExplainRequest. */
function parseExplainTarget(target: string, level?: ExplainRequest["experienceLevel"]): ExplainRequest | null {
  const m = /^([^/]+)\/(.+):(\d+)(?:-(\d+))?$/.exec(target);
  if (!m) return null;
  const startLine = parseInt(m[3], 10);
  const endLine = m[4] ? parseInt(m[4], 10) : startLine;
  return { repo: m[1], path: m[2], startLine, endLine, experienceLevel: level };
}

/** Manifest/marker files that make a directory "look like a repo". */
function looksLikeRepo(dir: string): boolean {
  return (
    existsSync(join(dir, ".git")) ||
    existsSync(join(dir, "package.json")) ||
    existsSync(join(dir, "pyproject.toml")) ||
    existsSync(join(dir, "go.mod")) ||
    existsSync(join(dir, "Cargo.toml")) ||
    existsSync(join(dir, "requirements.txt"))
  );
}

/**
 * Detect candidate repos under a target.
 * Returns repo-relative paths: "." when the TARGET ITSELF is a repo (the common
 * single-repo external-target case), else the immediate subdirs that look like
 * repos (a multi-repo workspace). This is what lets OpenClaw be pointed at either
 * shape of external project.
 */
function detectRepos(root: string): string[] {
  // Single-repo target: the target path itself is a repo.
  if (looksLikeRepo(root)) return ["."];

  // Multi-repo workspace: immediate subdirs that look like repos.
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
    if (looksLikeRepo(abs)) out.push(name);
  }
  return out.sort();
}

async function runScan(args: Args, now: number): Promise<void> {
  const err = validateTarget(args.targetPath);
  if (err) {
    console.error(`[scan] ${err}`);
    process.exit(1);
  }
  if (!args.targetExplicit) {
    console.error(`[scan] WARNING: no --target given; defaulting to \`${args.targetPath}\`. Pass --target <project-path> to study an external project.`);
  }
  console.error(`[scan] target project: ${args.targetPath}`);
  console.error(`[scan] writing index to HOST storage: ${args.out} (target is NOT modified)`);

  const repoNames = args.repos ?? detectRepos(args.targetPath);
  if (repoNames.length === 0) {
    console.error(`[scan] no repos found under ${args.targetPath}`);
    process.exit(1);
  }
  const repos = repoNames.map((name) => scanRepo(join(args.targetPath, name), { generatedAt: now }));

  // Safe local environment detection (read-only probes only; ports NOT checked
  // during scan — that's opt-in via `env --check-ports`).
  const { env, unknowns: envUnknowns } = await detectMachineEnv({ generatedAt: now });

  const ws: WorkspaceIntel = {
    rootPath: args.targetPath,
    targetPath: args.targetPath,
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

  // Auto-register / refresh this target in the HOST registry (never touches the
  // target — only host metadata). Records repo type, commits, unknowns, time.
  registerScannedTarget(args, ws, now);
}

/** Summarize a workspace's known-unknowns by impact for the registry entry. */
function summarizeUnknowns(ws: WorkspaceIntel): { total: number; byImpact: { high: number; medium: number; low: number } } {
  const all: KnownUnknown[] = [...ws.knownUnknowns, ...ws.repos.flatMap((r) => r.knownUnknowns)];
  const byImpact = { high: 0, medium: 0, low: 0 };
  for (const u of all) byImpact[u.confidenceImpact] += 1;
  return { total: all.length, byImpact };
}

/** Upsert the target into the registry and record this scan. Host-only writes. */
function registerScannedTarget(args: Args, ws: WorkspaceIntel, now: number): void {
  const reg = loadRegistry();
  const repoNames = ws.repos.map((r) => r.name);
  const repoType: "single-repo" | "multi-repo" =
    detectRepos(args.targetPath)[0] === "." ? "single-repo" : "multi-repo";
  upsertTarget(reg, {
    targetPath: args.targetPath,
    repoType,
    repos: repoNames,
    now,
    displayName: args.name,
    description: args.desc,
  });
  recordScan(
    reg,
    args.targetPath,
    now,
    ws.repos.map((r) => ({ repo: r.name, commit: r.gitCommit })),
    summarizeUnknowns(ws),
  );
  saveRegistry(reg);
  console.log(`[scan] registered target in host registry (id derived from path)`);
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
  if (!args.selection) {
    console.error('[explain] usage: explain "<repo>/<path>:<startLine>-<endLine>" --target <project-path> [--level junior]');
    process.exit(1);
  }
  const req = parseExplainTarget(args.selection, args.level);
  if (!req) {
    console.error(`[explain] could not parse selection "${args.selection}" — expected "<repo>/<path>:<start>-<end>"`);
    process.exit(1);
  }
  const jsonPath = join(args.out, "project-intel.json");
  if (!existsSync(jsonPath)) {
    console.error(`[explain] no scan at ${jsonPath} for target \`${args.targetPath}\` — run \`scan --target <path>\` first`);
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

/**
 * Manage the HOST target-project registry: add / list / show / remove.
 * All operations are host-metadata only — they NEVER touch a target project.
 *   targets add <path> [--name N] [--desc D]
 *   targets list
 *   targets show <id|name|path>
 *   targets remove <id|name|path>     (untracks; does NOT delete the target)
 */
function runTargets(args: Args, now: number): void {
  const sub = args.subcmd ?? "list";
  const reg = loadRegistry();

  if (sub === "add") {
    const raw = args.ref;
    if (!raw) {
      console.error("[targets] usage: targets add <path> [--name <name>] [--desc <description>]");
      process.exit(1);
    }
    const targetPath = resolve(raw);
    const err = validateTargetPath(targetPath);
    if (err) {
      console.error(`[targets] ${err}`);
      process.exit(1);
    }
    const repos = detectRepos(targetPath);
    if (repos.length === 0) {
      console.error(`[targets] no repos detected under ${targetPath} (not a repo or multi-repo workspace)`);
      process.exit(1);
    }
    const repoType: "single-repo" | "multi-repo" = repos[0] === "." ? "single-repo" : "multi-repo";
    const repoNames = repos[0] === "." ? [targetPath.split("/").filter(Boolean).pop() || "."] : repos;
    const entry = upsertTarget(reg, { targetPath, repoType, repos: repoNames, now, displayName: args.name, description: args.desc });
    saveRegistry(reg);
    console.log(`[targets] registered: ${entry.displayName} (id ${entry.id})`);
    console.log(`[targets]   path: ${entry.targetPath} · type: ${entry.repoType} · repos: ${entry.repos.join(", ")}`);
    console.log(`[targets]   storage: ${entry.storageDir} (host — target not modified)`);
    console.log(`[targets]   not scanned yet — run: scan --target ${entry.id}`);
    return;
  }

  if (sub === "list") {
    if (reg.projects.length === 0) {
      console.log("[targets] no registered projects. Add one: targets add <path>");
      return;
    }
    console.log(`[targets] ${reg.projects.length} registered project(s):`);
    for (const p of reg.projects) {
      const scanned = p.lastScannedAt ? new Date(p.lastScannedAt).toISOString() : "never";
      const ku = p.knownUnknownsSummary ? `${p.knownUnknownsSummary.total} unknowns` : "—";
      console.log(`  ${p.id}  ${p.displayName}  [${p.repoType}]  scanned:${scanned}  ${ku}`);
      console.log(`        ${p.targetPath}`);
    }
    return;
  }

  if (sub === "show") {
    if (!args.ref) {
      console.error("[targets] usage: targets show <id|name|path>");
      process.exit(1);
    }
    const p = resolveTarget(reg, args.ref);
    if (!p) {
      console.error(`[targets] not found: ${args.ref}`);
      process.exit(1);
    }
    console.log(JSON.stringify(p, null, 2));
    return;
  }

  if (sub === "remove") {
    if (!args.ref) {
      console.error("[targets] usage: targets remove <id|name|path>");
      process.exit(1);
    }
    const removed = removeTarget(reg, args.ref);
    if (!removed) {
      console.error(`[targets] not found: ${args.ref}`);
      process.exit(1);
    }
    saveRegistry(reg);
    console.log(`[targets] untracked: ${removed.displayName} (${removed.targetPath})`);
    console.log(`[targets] the target project was NOT deleted or modified — only removed from OpenClaw tracking.`);
    console.log(`[targets] (its host index at ${removed.storageDir} is left in place; delete it manually if you want.)`);
    return;
  }

  console.error(`[targets] unknown subcommand: ${sub} — use add | list | show | remove`);
  process.exit(1);
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
  else if (args.cmd === "targets") runTargets(args, now);
  else await runScan(args, now);
}

main();
