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

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { hashFile, readGitInfo, SCAN_VERSION } from "./grounding.js";
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
import {
  applyEnvironmentOverride,
  autoProbes,
  classifyEnvCheck,
  commandCompatibility,
  detectEnvironmentProfile,
  effectiveOsVariant,
  effectiveShell,
  environmentProfilePath,
  loadEnvironmentProfile,
  saveEnvironmentProfile,
  summarizeProfile,
  type EnvironmentOverrideUpdate,
} from "./environment.js";
import { explainSelection, listRepoFiles } from "./explain.js";
import { buildContextPack } from "./contextpack.js";
import { buildDeploymentReport } from "./deployment.js";
import { buildChangeReport } from "./change.js";
import { mergeVerificationStores, runVerification } from "./verify.js";
import { renderChangeReportMarkdown } from "./render.js";
import { ProjectStorage, hostStorageDir } from "./storage.js";
import { computeFreshness } from "./freshness.js";
import { buildFlowMap } from "./flowmap.js";
import { renderFlowMapMarkdown, renderDeploymentReportMarkdown } from "./render.js";
import {
  loadRegistry,
  recordScan,
  removeTarget,
  resolveTarget,
  saveRegistry,
  upsertTarget,
  validateTargetPath,
} from "./registry.js";
import {
  applyPreferenceUpdate,
  applyProjectMemoryUpdate,
  buildGuidance,
  defaultPreferences,
  emptyProjectMemory,
  loadPreferences,
  loadProjectMemory,
  preferencesPath,
  projectMemoryPath,
  savePreferences,
  saveProjectMemory,
  type ExperienceLevel,
  type PreferenceUpdate,
  type ProjectMemoryUpdate,
  type UserPreferences,
} from "./memory.js";
import { projectIdFor } from "./storage.js";
import type { ContextMode, ContextPackRequest, EnvironmentProfile, ExplainRequest, KnownUnknown, MachineEnv, OsVariant, VerificationStore, WorkspaceIntel } from "./types.js";

interface Args {
  cmd: "scan" | "check" | "diff" | "docs" | "env" | "explain" | "report" | "verify" | "targets" | "freshness" | "prefs" | "memory" | "context" | "deploy";
  /** Resolved absolute path of the TARGET PROJECT being studied (read-only). */
  targetPath: string;
  /** Whether the user explicitly supplied --target/--root (vs the legacy default). */
  targetExplicit: boolean;
  /** Storage dir for the index — host-side by default, NEVER inside the target. */
  out: string;
  /** Whether the user opted into project-local storage (<target>/.openclaw). */
  local: boolean;
  /** Emit a single JSON object on stdout (machine-readable, for the API). */
  json: boolean;
  repos?: string[];
  /** check: write invalidated freshness back to the artifact (default true). */
  write: boolean;
  /** env: ports to probe (opt-in, requires the user to pass --check-ports). */
  checkPorts?: number[];
  /** explain: positional selection "<repo>/<path>:<startLine>-<endLine>". */
  selection?: string;
  /** explain: experience level for the explanation lens. */
  level?: ExplainRequest["experienceLevel"];
  /** explain: optional free-text question / user intent. */
  intent?: string;
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
  /** context/explain: the user's question / intent. */
  question?: string;
  /** context: mode lens (onboarding|explain|change-confidence|deployment|command-help). */
  mode?: ContextMode;
  /** context: max items budget. */
  maxItems?: number;
  /** Raw flag map (for prefs/memory which accept many ad-hoc keys). */
  flags: Map<string, string>;
  /** Raw bool flags (e.g. --reset). */
  bools: Set<string>;
}

function parseArgs(argv: string[]): Args {
  const cmd = (["check", "diff", "docs", "env", "explain", "report", "verify", "targets", "freshness", "prefs", "memory", "context", "deploy"].includes(argv[0]) ? argv[0] : "scan") as Args["cmd"];
  const flags = new Map<string, string>();
  const bools = new Set<string>();
  const positionals: string[] = [];
  const VALUELESS = new Set(["no-write", "confirm", "local", "json", "reset", "analogies", "no-analogies", "diagrams", "no-diagrams", "pack", "no-pack", "save"]);
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
  // STORAGE: explicit --out wins; else --local opts into <target>/.openclaw
  // (modifies the target — only when the user asks); else host-side per-target dir.
  // NEVER default to a path inside the target (prompt-23/27 read-only policy).
  const local = bools.has("local");
  const explicitOut = flags.get("out") ? resolve(flags.get("out") as string) : undefined;
  const storage = ProjectStorage.for(targetPath, { local, explicitOut });
  const out = storage.dir;
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
    local,
    json: bools.has("json"),
    repos,
    write: !bools.has("no-write"),
    checkPorts,
    selection: positionals[0],
    level,
    intent: flags.get("intent") || flags.get("question") || flags.get("q") || undefined,
    run: flags.get("run") || undefined,
    runRepo: flags.get("repo") || undefined,
    confirmed: bools.has("confirm"),
    subcmd: positionals[0],
    ref: positionals[1],
    name: flags.get("name") || undefined,
    desc: flags.get("desc") || undefined,
    question: flags.get("question") || flags.get("q") || undefined,
    mode: (flags.get("mode") as ContextMode | undefined) || undefined,
    maxItems: flags.get("max") ? parseInt(flags.get("max") as string, 10) : undefined,
    flags,
    bools,
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
function parseExplainTarget(target: string, level?: ExplainRequest["experienceLevel"], intent?: string): ExplainRequest | null {
  const m = /^([^/]+)\/(.+):(\d+)(?:-(\d+))?$/.exec(target);
  if (!m) return null;
  const startLine = parseInt(m[3], 10);
  const endLine = m[4] ? parseInt(m[4], 10) : startLine;
  return { repo: m[1], path: m[2], startLine, endLine, experienceLevel: level, intent };
}

/** A package/build MANIFEST that makes a directory a repo root (not just `.git`). */
function hasManifest(dir: string): boolean {
  return (
    existsSync(join(dir, "package.json")) ||
    existsSync(join(dir, "pyproject.toml")) ||
    existsSync(join(dir, "go.mod")) ||
    existsSync(join(dir, "Cargo.toml")) ||
    existsSync(join(dir, "requirements.txt"))
  );
}

/** Does a directory look like a repo? A manifest, or a `.git` dir. */
function looksLikeRepo(dir: string): boolean {
  return hasManifest(dir) || existsSync(join(dir, ".git"));
}

/**
 * Detect candidate repos under a target.
 * Returns repo-relative paths: "." when the TARGET ITSELF is a repo (single-repo),
 * else the immediate subdirs that are repos (a multi-repo workspace).
 *
 * Key nuance (prompt 34): a multi-repo workspace is itself often a git repo, so a
 * root `.git` alone does NOT make it single-repo. We prefer subdir detection when
 * the root has no manifest but ≥2 subdirs do (or the root has no manifest and any
 * subdir does); we only treat the root as a single repo when it has its OWN
 * manifest, or it's a lone git repo with no repo-like subdirs.
 */
function detectRepos(root: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return looksLikeRepo(root) ? ["."] : out;
  }
  // Collect immediate subdirs that are repos (have their own manifest).
  const subRepos: string[] = [];
  for (const name of entries) {
    if (name.startsWith(".")) continue;
    const abs = join(root, name);
    try {
      if (!statSync(abs).isDirectory()) continue;
    } catch {
      continue;
    }
    if (hasManifest(abs)) subRepos.push(name);
  }

  // Single-repo: the root itself has a manifest (a monorepo root counts as one
  // repo here; its packages aren't split — that's a later refinement).
  if (hasManifest(root)) return ["."];
  // Multi-repo workspace: root has no manifest but subdirs are repos.
  if (subRepos.length > 0) return subRepos.sort();
  // Lone git repo with no manifest and no repo subdirs.
  if (existsSync(join(root, ".git"))) return ["."];

  // Nothing repo-like found.
  return out;
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
  if (args.local) {
    console.error(`[scan] --local: writing index INSIDE the target at ${args.out} (you opted in; this modifies the target)`);
  } else {
    console.error(`[scan] writing index to HOST storage: ${args.out} (target is NOT modified)`);
  }

  const repoNames = args.repos ?? detectRepos(args.targetPath);
  if (repoNames.length === 0) {
    console.error(`[scan] no repos found under ${args.targetPath}`);
    process.exit(1);
  }
  const repos = repoNames.map((name) => scanRepo(join(args.targetPath, name), { generatedAt: now }));

  // Safe local environment detection (read-only probes only; ports NOT checked
  // during scan — that's opt-in via `env --check-ports`). Prefer the PERSISTENT
  // host-side environment profile (prompt 39) so a remembered WSL/Windows choice +
  // shell override flow into the index without re-detecting every scan.
  const { env, unknowns: envUnknowns } = await resolveScanEnv(now);

  const ws: WorkspaceIntel = {
    rootPath: args.targetPath,
    targetPath: args.targetPath,
    scanVersion: SCAN_VERSION,
    generatedAt: now,
    repos,
    machineEnv: env,
    knownUnknowns: [...envUnknowns],
  };

  // Build the cross-repo flow map (prompt 34) — replaces the old placeholder.
  // Per-repo file lists (bounded, read-only) feed the URL/port signal detection.
  const repoFiles: Record<string, string[]> = {};
  for (const r of repos) repoFiles[r.name] = listRepoFiles(r.rootPath);
  ws.flowMap = buildFlowMap(ws, { generatedAt: now, repoFiles });

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

  // Cross-repo flow map (multi-repo workspaces).
  if (ws.flowMap) {
    writeFileSync(join(args.out, "flow-map.md"), renderFlowMapMarkdown(ws.flowMap), "utf-8");
    console.log(`[scan] flow map: ${ws.flowMap.nodes.filter((n) => n.kind === "repo").length} repo(s), ${ws.flowMap.edges.length} cross-repo edge(s) → ${join(args.out, "flow-map.md")}`);
  }

  // Generate onboarding docs + command book from the same grounded index.
  writeOnboardingDocs(ws, args.out, now);

  // Auto-register / refresh this target in the HOST registry (never touches the
  // target — only host metadata). Records repo type, commits, unknowns, time.
  registerScannedTarget(args, ws, now);

  if (args.json) {
    process.stdout.write(
      JSON.stringify({
        ok: true,
        targetPath: args.targetPath,
        storageDir: args.out,
        local: args.local,
        repos: ws.repos.map((r) => ({
          name: r.name,
          languages: r.languages,
          gitCommit: r.gitCommit,
          scripts: r.scripts.length,
          routes: r.routes.length,
          confidence: r.grounding.confidence,
          freshness: r.grounding.status,
          knownUnknowns: r.knownUnknowns.length,
        })),
        totalUnknowns,
      }) + "\n",
    );
  }
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
function writeOnboardingDocs(ws: WorkspaceIntel, out: string, now: number): void {
  const docsDir = join(out, "docs");
  mkdirSync(docsDir, { recursive: true });

  // Onboarding adapts to the user's remembered preferences (junior by default).
  const guidance = buildGuidance(loadPreferences(now));
  writeFileSync(join(docsDir, "onboarding-overview.md"), renderOverview(ws, guidance), "utf-8");
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
function runDocs(args: Args, now: number): void {
  const jsonPath = join(args.out, "project-intel.json");
  if (!existsSync(jsonPath)) {
    console.error(`[docs] no scan at ${jsonPath} — run \`scan\` first`);
    process.exit(1);
  }
  const ws = JSON.parse(readFileSync(jsonPath, "utf-8")) as WorkspaceIntel;
  writeOnboardingDocs(ws, args.out, now);
}

/**
 * Apply the profile's effective shell/OS-variant overrides onto a detected
 * MachineEnv, so the index/command-book reflect the user's REMEMBERED environment
 * (e.g. a manually-pinned shell) rather than only raw detection (prompt 39).
 */
function effectiveMachineEnv(profile: EnvironmentProfile): MachineEnv {
  const variant = effectiveOsVariant(profile);
  return {
    ...profile.machine,
    shell: effectiveShell(profile),
    // reflect a user-overridden WSL choice so downstream notes stay correct
    isWSL: profile.overrides.osVariant ? variant === "wsl" : profile.machine.isWSL,
  };
}

/**
 * Resolve the MachineEnv for a scan: reuse a FRESH persisted profile if present
 * (carrying user overrides), else detect + persist a new one. Keeps the host-side
 * profile the single source of truth for "what machine am I on".
 */
async function resolveScanEnv(now: number): Promise<{ env: MachineEnv; unknowns: KnownUnknown[] }> {
  const prev = loadEnvironmentProfile();
  if (prev) return { env: effectiveMachineEnv(prev), unknowns: [] };
  const { profile, unknowns } = await detectEnvironmentProfile(now, null);
  saveEnvironmentProfile(profile);
  return { env: effectiveMachineEnv(profile), unknowns };
}

/**
 * Detect the local machine environment and merge it into the last scan (so
 * onboarding docs gain setup-compatibility notes). Safe probes always run; port
 * checks run ONLY when --check-ports is passed (explicit user confirmation).
 *
 * `env` subcommands (prompt 39): show | refresh | inspect | set.
 */
async function runEnv(args: Args, now: number): Promise<void> {
  const sub = args.subcmd ?? "inspect";

  // ----- `env show`: print the persisted profile WITHOUT re-detecting -----
  if (sub === "show") {
    const profile = loadEnvironmentProfile();
    if (!profile) {
      console.error("[env] no environment profile yet — run `env refresh` (or `env`) to detect + persist one.");
      process.exit(1);
    }
    printProfile(profile);
    return;
  }

  // ----- `env set`: manually pin shell / OS variant / command style (persists) -----
  if (sub === "set") {
    const profile = loadEnvironmentProfile();
    if (!profile) {
      console.error("[env] no environment profile yet — run `env refresh` first, then `env set`.");
      process.exit(1);
    }
    const update: EnvironmentOverrideUpdate = {};
    const variant = args.flags.get("os-variant") || args.flags.get("variant");
    if (variant) {
      const allowed: OsVariant[] = ["wsl", "windows", "macos", "linux", "unknown"];
      if (!allowed.includes(variant as OsVariant)) {
        console.error(`[env] invalid --os-variant "${variant}" (expected: ${allowed.join(", ")})`);
        process.exit(1);
      }
      update.osVariant = variant as OsVariant;
    }
    if (args.flags.has("shell")) update.shell = args.flags.get("shell") || undefined;
    if (args.flags.has("command-style")) update.commandStyle = args.flags.get("command-style") || undefined;
    if (args.flags.get("working-dir")) update.addWorkingDir = resolve(args.flags.get("working-dir") as string);
    if (Object.keys(update).length === 0) {
      console.error("[env] set: nothing to update — pass e.g. --os-variant wsl --shell /bin/zsh --working-dir /path");
      process.exit(1);
    }
    const next = applyEnvironmentOverride(profile, update, now);
    saveEnvironmentProfile(next);
    console.log(`[env] updated overrides: ${Object.keys(update).join(", ")}`);
    printProfile(next);
    return;
  }

  // ----- `env check "<command>"`: report whether a command fits this machine -----
  if (sub === "check") {
    const profile = loadEnvironmentProfile();
    if (!profile) {
      console.error("[env] no environment profile yet — run `env refresh` first.");
      process.exit(1);
    }
    const cmd = args.ref ?? args.flags.get("command") ?? "";
    if (!cmd) {
      console.error('[env] usage: env check "<command>"  — e.g. env check "uv run pytest"');
      process.exit(1);
    }
    const compat = commandCompatibility(cmd, profile);
    const safety = classifyEnvCheck(cmd);
    console.log(`[env] \`${cmd}\` on a ${effectiveOsVariant(profile)} machine:`);
    console.log(`  compatibility: ${compat.status} — ${compat.note}`);
    console.log(`  safety       : ${safety.classification} — ${safety.reason}`);
    return;
  }

  // ----- `env refresh` / `env inspect` (default): detect (safe probes) + persist -----
  if (args.checkPorts && args.checkPorts.length) {
    console.log(`[env] --check-ports given: probing ports ${args.checkPorts.join(", ")} (local bind test, no network egress)`);
  }
  const prev = loadEnvironmentProfile();
  const { profile, unknowns } = await detectEnvironmentProfile(now, prev);
  // carry forward overrides + working dirs (detectEnvironmentProfile already did),
  // then optionally fold in opt-in port checks for the on-disk machine snapshot.
  if (args.checkPorts && args.checkPorts.length) {
    const withPorts = await detectMachineEnv({ generatedAt: now, checkPorts: args.checkPorts });
    profile.machine.ports = withPorts.env.ports;
  }
  saveEnvironmentProfile(profile);
  printProfile(profile);
  console.log(`[env] profile persisted → ${environmentProfilePath()} (HOST storage — outside any target)`);

  // If a prior scan exists, merge the EFFECTIVE env into it + regenerate docs so the
  // command book/overview pick up setup compatibility for the remembered machine.
  const jsonPath = join(args.out, "project-intel.json");
  if (existsSync(jsonPath)) {
    const ws = JSON.parse(readFileSync(jsonPath, "utf-8")) as WorkspaceIntel;
    ws.machineEnv = effectiveMachineEnv(profile);
    ws.knownUnknowns = ws.knownUnknowns.filter((u) => u.kind !== "missing-tool" && u.kind !== "unverified-port").concat(unknowns);
    writeFileSync(jsonPath, JSON.stringify(ws, null, 2), "utf-8");
    writeFileSync(join(args.out, "project-map.md"), renderWorkspaceMarkdown(ws), "utf-8");
    writeOnboardingDocs(ws, args.out, now);
    console.log(`[env] merged environment into ${jsonPath} + regenerated docs`);
  }
}

/** Print the environment profile (human-readable) with safety + compatibility notes. */
function printProfile(profile: EnvironmentProfile): void {
  console.log("[env] Local environment profile (host-side — persists across sessions & projects):");
  console.log(`  OS variant   : ${effectiveOsVariant(profile)}${profile.overrides.osVariant ? " (user-set override)" : " (detected)"}`);
  console.log(`  shell        : ${effectiveShell(profile) ?? "unknown"}${profile.overrides.shell ? " (user-set)" : ""}`);
  console.log(`  arch         : ${profile.machine.arch}`);
  if (profile.overrides.commandStyle) console.log(`  command style: ${profile.overrides.commandStyle} (user-set)`);
  if (profile.workingDirs.length) console.log(`  working dirs : ${profile.workingDirs.join(", ")}`);
  console.log("  tools:");
  for (const t of profile.machine.tools) {
    console.log(`    ${t.available ? "✓" : "✗"} ${t.name}${t.version ? ` ${t.version}` : ""}`);
  }
  const missing = profile.machine.tools.filter((t) => !t.available).map((t) => t.name);
  if (missing.length) console.log(`  missing tools: ${missing.join(", ")} — setup checker will flag commands needing these.`);
  console.log(`  refreshed    : ${new Date(profile.refreshedAt).toISOString()}`);
  console.log(`  stored at    : ${environmentProfilePath()}  (outside any target project)`);
  console.log(`  summary      : ${summarizeProfile(profile)}`);
  const probes = autoProbes();
  const allSafe = probes.every((p) => p.classification === "safe-auto");
  console.log(`  auto-run probes: ${probes.length} read-only version checks${allSafe ? ", all classified safe-auto" : ""} (nothing installed, no service started).`);
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
  const req = parseExplainTarget(args.selection, args.level, args.intent);
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
  // Apply remembered preferences (global) + per-project memory so a once-set
  // "junior" lens is used automatically without re-stating it (prompt 36).
  const guidance = guidanceFor(args, now);
  // Remember that the user inspected this file (curated project memory).
  rememberInspectedFile(args, now, req.path, req.intent);
  const pkg = explainSelection(req, ws, { generatedAt: now, repoFiles, guidance });

  // Prompt 37: highlight-to-explain attaches an automatic context pack (unless
  // --no-pack) so the relevant project context travels WITH the explanation — no
  // hand-attached files. The pack is read-only + host-only.
  if (!args.bools.has("no-pack")) {
    pkg.contextPack = buildContextPack(
      {
        projectId: projectIdFor(args.targetPath),
        question: req.intent ?? `Explain ${req.path}:${req.startLine}-${req.endLine}`,
        repo: req.repo,
        filePath: req.path,
        startLine: req.startLine,
        endLine: req.endLine,
        selectedCode: req.selectedText,
        mode: "explain",
      },
      ws,
      { generatedAt: now, guidance, maxItems: args.maxItems },
    );
  }

  // Print the structured package for a future frontend; stderr carries a 1-line summary.
  console.error(
    `[explain] ${req.repo}/${req.path}:${req.startLine}-${req.endLine} → confidence=${pkg.confidence}, freshness=${pkg.freshness}${pkg.staleWarning ? " (STALE)" : ""}${pkg.contextPack ? `, contextPack=${pkg.contextPack.items.length} item(s)` : ""}`,
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
  // Apply the user's remembered risk-tolerance to the verdict FRAMING only — the
  // honesty rule (never "safe to push") is unchanged (prompt 36).
  const prefs = loadPreferences(now);
  const report = buildChangeReport(ws, { generatedAt: now, verification, riskTolerance: prefs.riskTolerance });

  // Write the "latest" report + append an immutable copy to per-target history.
  const storage = new ProjectStorage(args.out, args.local);
  const md = renderChangeReportMarkdown(report);
  const mdPath = join(args.out, "change-report.md");
  const reportJson = join(args.out, "change-report.json");
  writeFileSync(mdPath, md, "utf-8");
  writeFileSync(reportJson, JSON.stringify(report, null, 2), "utf-8");
  const hist = storage.appendReportHistory(now, report, md);

  for (const r of report.repos) {
    if (r.summary.total > 0) console.log(`[report] ${r.repo}: ${r.summary.total} changed file(s), ${r.recommendedCommands.length} recommended command(s)`);
  }
  if (verification) console.log(`[report] folded in ${verification.results.length} prior verification result(s)`);
  console.log(`[report] ${report.verdict}`);
  console.log(`[report] wrote ${mdPath} + ${reportJson}`);
  console.log(`[report] appended to report history: ${hist.mdPath}`);
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
    if (args.json) {
      process.stdout.write(JSON.stringify({ ok: true, project: entry }) + "\n");
      return;
    }
    console.log(`[targets] registered: ${entry.displayName} (id ${entry.id})`);
    console.log(`[targets]   path: ${entry.targetPath} · type: ${entry.repoType} · repos: ${entry.repos.join(", ")}`);
    console.log(`[targets]   storage: ${entry.storageDir} (host — target not modified)`);
    console.log(`[targets]   not scanned yet — run: scan --target ${entry.id}`);
    return;
  }

  if (sub === "list") {
    if (args.json) {
      process.stdout.write(JSON.stringify({ ok: true, projects: reg.projects }) + "\n");
      return;
    }
    if (reg.projects.length === 0) {
      console.log("[targets] no registered projects. Add one: targets add <path>");
      return;
    }
    console.log(`[targets] ${reg.projects.length} registered project(s):`);
    for (const p of reg.projects) {
      const scanned = p.lastScannedAt ? new Date(p.lastScannedAt).toISOString() : "never";
      const ku = p.knownUnknownsSummary ? `${p.knownUnknownsSummary.total} unknowns` : "—";
      const fr = p.freshness ? `freshness:${p.freshness.overall}` : "freshness:unchecked";
      console.log(`  ${p.id}  ${p.displayName}  [${p.repoType}]  scanned:${scanned}  ${fr}  ${ku}`);
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

/**
 * Freshness check (prompt 28): compare a stored scan against the target's CURRENT
 * state and report fresh / possibly-stale / stale / unknown, which file
 * categories drifted, and which generated artifacts are now suspect. READ-ONLY —
 * it only hashes files + reads git in the target; it never writes to the target.
 * Persists the verdict into the registry so `targets list` reflects it.
 */
function runFreshness(args: Args): void {
  const jsonPath = join(args.out, "project-intel.json");
  if (!existsSync(jsonPath)) {
    console.error(`[freshness] no scan at ${jsonPath} for \`${args.targetPath}\` — run \`scan --target <path>\` first`);
    process.exit(1);
  }
  const ws = JSON.parse(readFileSync(jsonPath, "utf-8")) as WorkspaceIntel;

  const result = computeFreshness(
    ws,
    (repoRoot, rel) => hashFile(join(repoRoot, rel)),
    (repoRoot) => {
      const g = readGitInfo(repoRoot);
      return { commit: g.commit, dirty: g.dirty };
    },
  );

  // Persist the verdict into the registry entry first (host metadata only).
  const reg0 = loadRegistry();
  const entry0 = resolveTarget(reg0, args.targetPath);
  if (entry0) {
    entry0.freshness = { overall: result.overall, checkedAt: Date.now() };
    saveRegistry(reg0);
  }

  if (args.json) {
    // Machine-readable: the verdict is IN the payload, so exit 0 regardless.
    process.stdout.write(JSON.stringify({ ok: true, freshness: result, projectId: entry0?.id ?? null }) + "\n");
    return;
  }

  console.log(`[freshness] target: ${result.targetPath}`);
  console.log(`[freshness] OVERALL: ${result.overall.toUpperCase()}`);
  for (const r of result.repos) {
    console.log(`[freshness] ${r.repo}: ${r.verdict}${r.scanCommit ? ` (scan ${r.scanCommit}${r.currentCommit && r.currentCommit !== r.scanCommit ? ` → now ${r.currentCommit}` : ""})` : ""}`);
    for (const reason of r.reasons) console.log(`            · ${reason}`);
    if (r.driftedFiles.length) {
      console.log(`            drifted: ${r.driftedFiles.slice(0, 8).map((d) => `${d.path} [${d.category}]`).join(", ")}${r.driftedFiles.length > 8 ? `, +${r.driftedFiles.length - 8} more` : ""}`);
    }
    if (r.affectedArtifacts.length) {
      console.log(`            ⚠ possibly-affected artifacts: ${r.affectedArtifacts.join(", ")}`);
    }
  }

  if (result.overall === "stale") {
    console.log(`[freshness] stored intelligence is STALE — re-scan with: scan --target ${entry0?.id ?? args.targetPath}`);
    process.exit(2);
  } else if (result.overall === "possibly-stale") {
    console.log(`[freshness] stored intelligence MAY be stale — consider re-scanning.`);
    process.exit(2);
  }
  console.log(`[freshness] stored intelligence is fresh.`);
}

// ---------------------------------------------------------------------------
// Persistent memory & personalization (prompt 36)
// ---------------------------------------------------------------------------

/**
 * Resolve the registered/target entry for the current args, if any, so per-project
 * memory can be loaded. Returns null when no target is registered/scanned yet.
 */
function resolveProjectMemoryContext(args: Args, now: number): { projectId: string; targetPath: string } | null {
  // Only meaningful when we have a real target path (explicit or resolvable).
  if (!args.targetExplicit && !existsSync(join(args.out, "project-intel.json"))) return null;
  const targetPath = args.targetPath;
  return { projectId: projectIdFor(targetPath), targetPath };
}

/** Assemble guidance from global prefs + this target's project memory (prompt 36). */
function guidanceFor(args: Args, now: number) {
  const prefs = loadPreferences(now);
  const ctx = resolveProjectMemoryContext(args, now);
  const mem = ctx ? loadProjectMemory(ctx.targetPath, ctx.projectId, now) : null;
  return buildGuidance(prefs, mem);
}

/** Curate "the user inspected this file" into project memory (host-only, capped). */
function rememberInspectedFile(args: Args, now: number, path: string, intent?: string): void {
  const ctx = resolveProjectMemoryContext(args, now);
  if (!ctx) return;
  const memPath = projectMemoryPath(ctx.targetPath);
  const mem = loadProjectMemory(ctx.targetPath, ctx.projectId, now, memPath);
  const update: ProjectMemoryUpdate = { addInspectedFile: path };
  if (intent) update.addQuestion = intent;
  saveProjectMemory(applyProjectMemoryUpdate(mem, update, now), memPath);
}

/** Curate "the user asked this question" into project memory (host-only, capped). */
function rememberQuestion(args: Args, now: number, question: string): void {
  const ctx = resolveProjectMemoryContext(args, now);
  if (!ctx) return;
  const memPath = projectMemoryPath(ctx.targetPath);
  const mem = loadProjectMemory(ctx.targetPath, ctx.projectId, now, memPath);
  saveProjectMemory(applyProjectMemoryUpdate(mem, { addQuestion: question }, now), memPath);
}

const EXPERIENCE_LEVELS: ExperienceLevel[] = ["new-to-repo", "junior", "mid", "senior"];
const STYLES: UserPreferences["style"][] = ["clear-step-by-step", "flow-oriented", "concise", "reference"];
const DETAILS: UserPreferences["detail"][] = ["brief", "balanced", "thorough"];
const RISKS: UserPreferences["riskTolerance"][] = ["cautious", "balanced", "pragmatic"];

function printPreferences(prefs: UserPreferences): void {
  console.log("[prefs] Global user preferences (apply to every project; project memory can add context):");
  console.log(`  explanation level : ${prefs.explanationLevel}`);
  console.log(`  style             : ${prefs.style}`);
  console.log(`  detail            : ${prefs.detail}`);
  console.log(`  analogies/examples: ${prefs.includeAnalogies ? "yes" : "no"}`);
  console.log(`  diagrams          : ${prefs.includeDiagrams ? "yes" : "no"}`);
  console.log(`  preferred shell   : ${prefs.preferredShell ?? "(auto-detect)"}`);
  console.log(`  risk tolerance    : ${prefs.riskTolerance} (wording only — never says "safe to push")`);
  console.log(`  updated           : ${new Date(prefs.updatedAt).toISOString()}`);
  console.log(`  stored at         : ${preferencesPath()}  (host storage — outside any target)`);
}

/**
 * `prefs` command: view / update / reset GLOBAL user preferences (prompt 36).
 *   prefs                       → show (also `prefs show`)
 *   prefs set --level junior --style flow-oriented --detail thorough \
 *             --shell zsh --risk cautious --analogies|--no-analogies --diagrams|--no-diagrams
 *   prefs reset                 → restore defaults (junior lens)
 * Pure host-side: never reads or writes any target project.
 */
function runPrefs(args: Args, now: number): void {
  const sub = args.subcmd ?? "show";
  if (sub === "reset" || args.bools.has("reset")) {
    const prefs = defaultPreferences(now);
    savePreferences(prefs);
    console.log("[prefs] reset to defaults (junior-engineer lens).");
    printPreferences(prefs);
    return;
  }
  if (sub === "set") {
    const prefs = loadPreferences(now);
    const update: PreferenceUpdate = {};
    const level = args.flags.get("level");
    if (level) {
      if (!EXPERIENCE_LEVELS.includes(level as ExperienceLevel)) {
        console.error(`[prefs] invalid --level "${level}" (expected: ${EXPERIENCE_LEVELS.join(", ")})`);
        process.exit(1);
      }
      update.explanationLevel = level as ExperienceLevel;
    }
    const style = args.flags.get("style");
    if (style) {
      if (!STYLES.includes(style as UserPreferences["style"])) {
        console.error(`[prefs] invalid --style "${style}" (expected: ${STYLES.join(", ")})`);
        process.exit(1);
      }
      update.style = style as UserPreferences["style"];
    }
    const detail = args.flags.get("detail");
    if (detail) {
      if (!DETAILS.includes(detail as UserPreferences["detail"])) {
        console.error(`[prefs] invalid --detail "${detail}" (expected: ${DETAILS.join(", ")})`);
        process.exit(1);
      }
      update.detail = detail as UserPreferences["detail"];
    }
    const risk = args.flags.get("risk");
    if (risk) {
      if (!RISKS.includes(risk as UserPreferences["riskTolerance"])) {
        console.error(`[prefs] invalid --risk "${risk}" (expected: ${RISKS.join(", ")})`);
        process.exit(1);
      }
      update.riskTolerance = risk as UserPreferences["riskTolerance"];
    }
    if (args.flags.has("shell")) update.preferredShell = args.flags.get("shell") || null;
    if (args.bools.has("analogies")) update.includeAnalogies = true;
    if (args.bools.has("no-analogies")) update.includeAnalogies = false;
    if (args.bools.has("diagrams")) update.includeDiagrams = true;
    if (args.bools.has("no-diagrams")) update.includeDiagrams = false;
    if (Object.keys(update).length === 0) {
      console.error("[prefs] set: nothing to update — pass e.g. --level junior --style flow-oriented");
      process.exit(1);
    }
    const next = applyPreferenceUpdate(prefs, update, now);
    savePreferences(next);
    console.log(`[prefs] updated: ${Object.keys(update).join(", ")}`);
    printPreferences(next);
    return;
  }
  // default: show
  printPreferences(loadPreferences(now));
}

/**
 * `memory` command: show / update / reset PER-PROJECT memory (prompt 36).
 *   memory --target <id|name|path>                 → show summary
 *   memory set --target <t> --nickname "the API" --confused "..." --flow flow-map
 *   memory reset --target <t>                       → clear this project's memory
 * Per-project memory lives in the target's HOST storage dir; the target is never touched.
 */
function runMemory(args: Args, now: number): void {
  const ctx = resolveProjectMemoryContext(args, now);
  if (!ctx) {
    console.error("[memory] no target resolved — pass --target <id|name|path> (and scan it first).");
    process.exit(1);
  }
  const memPath = projectMemoryPath(ctx.targetPath);
  const sub = args.subcmd ?? "show";

  if (sub === "reset" || args.bools.has("reset")) {
    saveProjectMemory(emptyProjectMemory(ctx.projectId, ctx.targetPath, now), memPath);
    console.log(`[memory] reset project memory for ${ctx.targetPath}`);
    return;
  }
  if (sub === "set") {
    const mem = loadProjectMemory(ctx.targetPath, ctx.projectId, now, memPath);
    const update: ProjectMemoryUpdate = {};
    if (args.flags.has("nickname")) update.nickname = args.flags.get("nickname") || null;
    if (args.flags.get("question")) update.addQuestion = args.flags.get("question");
    if (args.flags.get("confused")) update.addConfusion = args.flags.get("confused");
    if (args.flags.get("file")) update.addInspectedFile = args.flags.get("file");
    if (args.flags.get("flow")) update.addPreferredFlow = args.flags.get("flow");
    if (args.flags.get("explanation")) update.addExplanation = { note: args.flags.get("explanation") as string, at: now };
    if (Object.keys(update).length === 0) {
      console.error("[memory] set: nothing to update — pass e.g. --nickname \"the API\" --confused \"auth flow\"");
      process.exit(1);
    }
    const next = applyProjectMemoryUpdate(mem, update, now);
    saveProjectMemory(next, memPath);
    console.log(`[memory] updated: ${Object.keys(update).join(", ")}`);
    return;
  }

  // default: show summary
  const mem = loadProjectMemory(ctx.targetPath, ctx.projectId, now, memPath);
  if (args.json) {
    process.stdout.write(JSON.stringify(mem, null, 2) + "\n");
    return;
  }
  console.log(`[memory] Project memory for ${ctx.targetPath} (id ${ctx.projectId}):`);
  console.log(`  nickname           : ${mem.nickname ?? "(none)"}`);
  console.log(`  previous questions : ${mem.previousQuestions.length ? mem.previousQuestions.slice(-5).join(" | ") : "(none)"}`);
  console.log(`  useful explanations: ${mem.usefulExplanations.length ? mem.usefulExplanations.slice(-3).map((e) => e.note).join(" | ") : "(none)"}`);
  console.log(`  confusion points   : ${mem.confusionPoints.length ? mem.confusionPoints.join(" | ") : "(none)"}`);
  console.log(`  inspected files    : ${mem.inspectedFiles.length ? mem.inspectedFiles.slice(-8).join(", ") : "(none)"}`);
  console.log(`  preferred flows    : ${mem.preferredFlows.length ? mem.preferredFlows.join(", ") : "(none)"}`);
  console.log(`  stored at          : ${memPath}  (host storage — outside the target)`);
}

/**
 * Automatic Context Pack (prompt 37): assemble the relevant, source-grounded
 * project context for a question + optional selection, so the user never
 * hand-makes attachment files. Prints the pack as JSON (machine-readable) and a
 * human summary on stderr. `--save` keeps a timestamped copy in HOST storage
 * (debugging/history) — NEVER inside the target.
 *   context --target <t> --question "how does chat routing work?" [--mode explain]
 *           ["<repo>/<path>:<a>-<b>"] [--max 24] [--save] [--json]
 */
function runContext(args: Args, now: number): void {
  const jsonPath = join(args.out, "project-intel.json");
  if (!existsSync(jsonPath)) {
    console.error(`[context] no scan at ${jsonPath} for \`${args.targetPath}\` — run \`scan --target <path>\` first`);
    process.exit(1);
  }
  if (!args.question && !args.selection) {
    console.error('[context] usage: context --target <t> --question "<your question>" [--mode explain] ["<repo>/<path>:<a>-<b>"] [--save]');
    process.exit(1);
  }
  const ws = JSON.parse(readFileSync(jsonPath, "utf-8")) as WorkspaceIntel;

  // An optional positional selection ("<repo>/<path>:<a>-<b>") grounds the pack in code.
  const sel = args.selection ? parseExplainTarget(args.selection) : null;
  const req: ContextPackRequest = {
    projectId: projectIdFor(args.targetPath),
    question: args.question ?? `Explain ${args.selection}`,
    repo: sel?.repo,
    filePath: sel?.path,
    startLine: sel?.startLine,
    endLine: sel?.endLine,
    mode: args.mode ?? (sel ? "explain" : "onboarding"),
  };
  const guidance = guidanceFor(args, now);
  const pack = buildContextPack(req, ws, { generatedAt: now, guidance, maxItems: args.maxItems });

  // Remember the question against the project (curated memory) — host-only.
  if (args.question) rememberQuestion(args, now, args.question);

  console.error(
    `[context] mode=${pack.mode} → ${pack.selection.included}/${pack.selection.candidates} item(s), confidence=${pack.confidence}, freshness=${pack.freshness}${pack.selection.droppedForBudget ? ` (${pack.selection.droppedForBudget} dropped for budget)` : ""}`,
  );

  if (args.bools.has("save")) {
    // HOST storage only (req #9): latest + timestamped history. NEVER in the target.
    const storage = new ProjectStorage(args.out, args.local);
    storage.writeJson("contextPack", pack);
    const histDir = join(args.out, "context-history");
    mkdirSync(histDir, { recursive: true });
    const histPath = join(histDir, `context-${now}.json`);
    writeFileSync(histPath, JSON.stringify(pack, null, 2), "utf-8");
    console.error(`[context] saved → ${storage.path("contextPack")} + ${histPath}`);
  }

  process.stdout.write(JSON.stringify(pack, null, 2) + "\n");
}

/**
 * Deployment Explorer (prompt 38): detect deployment signals from a registered
 * target and explain how it's deployed (or might be) — current model, service
 * boundaries, runtime deps, env vars, build/run/deploy commands, a Mermaid
 * diagram, and an explicit source-grounded / inferred / unknown split. Writes
 * deployment-report.{md,json} to HOST storage. READ-ONLY w.r.t. the target.
 *   deploy --target <id|name|path> [--json]
 */
function runDeploy(args: Args, now: number): void {
  const jsonPath = join(args.out, "project-intel.json");
  if (!existsSync(jsonPath)) {
    console.error(`[deploy] no scan at ${jsonPath} for \`${args.targetPath}\` — run \`scan --target <path>\` first`);
    process.exit(1);
  }
  const ws = JSON.parse(readFileSync(jsonPath, "utf-8")) as WorkspaceIntel;
  const report = buildDeploymentReport(ws, { generatedAt: now });

  if (args.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    return;
  }

  // Write the report (md + json) to HOST storage — never inside the target.
  const storage = new ProjectStorage(args.out, args.local);
  const md = renderDeploymentReportMarkdown(report);
  storage.writeText("deploymentMd", md);
  storage.writeJson("deploymentJson", report);

  const totalSignals = report.repos.reduce((n, r) => n + r.signals.length, 0);
  console.error(
    `[deploy] ${report.repos.length} repo(s), ${totalSignals} signal(s)${report.crossRepoLinks.length ? `, ${report.crossRepoLinks.length} cross-repo link(s)` : ""} → confidence=${report.confidence}, freshness=${report.freshness}`,
  );
  console.error(`[deploy] ${report.summary}`);
  console.error(`[deploy] wrote ${storage.path("deploymentMd")} + ${storage.path("deploymentJson")}`);
  process.stdout.write(md + "\n");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const now = Date.now(); // injected here at the edge ONLY
  if (args.cmd === "check") runCheck(args);
  else if (args.cmd === "diff") runDiff(args);
  else if (args.cmd === "docs") runDocs(args, now);
  else if (args.cmd === "env") await runEnv(args, now);
  else if (args.cmd === "explain") runExplain(args, now);
  else if (args.cmd === "report") runReport(args, now);
  else if (args.cmd === "verify") await runVerify(args, now);
  else if (args.cmd === "targets") runTargets(args, now);
  else if (args.cmd === "freshness") runFreshness(args);
  else if (args.cmd === "prefs") runPrefs(args, now);
  else if (args.cmd === "memory") runMemory(args, now);
  else if (args.cmd === "context") runContext(args, now);
  else if (args.cmd === "deploy") runDeploy(args, now);
  else await runScan(args, now);
}

main();
