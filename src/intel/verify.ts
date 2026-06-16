// Safe Runtime Verification (13-...md §7, milestone). Pure-ish + host-local.
//
// Increases confidence by running SAFE, EXPLICIT checks through the local
// capability layer (ocv owns local machine access — 03-...md). The safety model
// is the whole point:
//
//   safe-auto         — read-only, fast, no side effects → run automatically
//                       (tool --version, env-file existence, deps-installed probe,
//                        port checks, allowlisted read-only commands)
//   confirm-required  — may take time / touch state but is non-destructive
//                       (test / lint / build) → run ONLY with explicit confirmation
//   blocked           — destructive / installing / long-running services
//                       (install, deploy, migrate, rm, dev-server, docker up) →
//                       NEVER run, always refused
//
// Results are persisted (verification.json) so the command book + change report
// can mark commands runtime-verified and fold pass/fail into confidence. Every
// result distinguishes statically-inferred from runtime-verified knowledge.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { buildGrounding } from "./grounding.js";
import type {
  CheckClassification,
  Grounding,
  VerificationCheck,
  VerificationResult,
  VerificationStore,
  WorkspaceIntel,
} from "./types.js";

const exec = promisify(execFile);
const TIMEOUT_MS = 60_000; // tests can be slow; hard cap so nothing hangs forever
const OUTPUT_CAP = 4000;

// ---------- classification ----------

/**
 * Patterns that make a command DESTRUCTIVE / stateful / long-running → blocked.
 * Conservative: when in doubt, block. (07-...md §0 deny set + 13-...md §7.)
 */
const BLOCKED_PATTERNS = [
  /\b(rm|rmdir|mv|dd|mkfs|shutdown|reboot)\b/,
  /\b(npm|pnpm|yarn|pip|uv|brew|apt|apt-get|gem|cargo)\s+(i|install|add|sync|ci|uninstall|remove)\b/,
  /\b(deploy|publish|release|push)\b/,
  /\b(migrate|migration|db:|seed|drop)\b/,
  /\bdocker\s+(run|up|compose|build|push)\b/,
  /\b(start|serve|dev)\b/, // long-running dev servers
  /[>|]/, // shell redirection/pipes — refuse, we don't run via a shell
  /&&|\|\||;/, // command chaining
];

/** Commands that are read-only / fast → safe to auto-run. */
const SAFE_PATTERNS = [
  /--version\b/,
  /\bversion\b/,
  /--help\b/,
  /\b(node|python3?|git|docker|make|uv|npm|pnpm|yarn)\s+(-v|--version|--help|version)\b/,
];

/** Test/lint/build → non-destructive but confirm-required (time/state). */
const CONFIRM_PATTERNS = [
  /\b(test|vitest|pytest|jest|mocha)\b/,
  /\b(lint|eslint|ruff|flake8|tsc)\b/,
  /\b(build|compile)\b/,
];

/**
 * Classify an arbitrary command. blocked dominates (checked first), then
 * confirm-required, then safe-auto; an unrecognized command is confirm-required
 * by default (never silently auto-run, never silently blocked).
 */
export function classifyCommand(command: string): { classification: CheckClassification; reason: string } {
  const c = command.trim();
  for (const re of BLOCKED_PATTERNS) {
    if (re.test(c)) return { classification: "blocked", reason: "matches a destructive / installing / long-running / shell-chaining pattern — never run automatically" };
  }
  for (const re of SAFE_PATTERNS) {
    if (re.test(c)) return { classification: "safe-auto", reason: "read-only version/help probe — safe to run automatically" };
  }
  for (const re of CONFIRM_PATTERNS) {
    if (re.test(c)) return { classification: "confirm-required", reason: "non-destructive but may take time / touch local state — requires explicit confirmation" };
  }
  return { classification: "confirm-required", reason: "unrecognized command — requires explicit confirmation before running" };
}

// ---------- low-level safe runner ----------

/** Split a simple "prog arg arg" command. Returns null if it looks shell-ish (we refuse those). */
function splitCommand(command: string): { prog: string; args: string[] } | null {
  if (/[>|&;`$()]/.test(command)) return null; // no shell metacharacters
  const parts = command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g);
  if (!parts || parts.length === 0) return null;
  const prog = parts[0].replace(/^["']|["']$/g, "");
  const args = parts.slice(1).map((a) => a.replace(/^["']|["']$/g, ""));
  return { prog, args };
}

interface RunOutcome {
  exitCode: number | null;
  output: string;
}

/** Run a command with execFile (no shell), bounded time + output. Never throws. */
async function runBounded(command: string, cwd: string): Promise<RunOutcome> {
  const split = splitCommand(command);
  if (!split) return { exitCode: null, output: "refused: command contains shell metacharacters (no shell execution)" };
  try {
    const { stdout, stderr } = await exec(split.prog, split.args, { cwd, timeout: TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 });
    return { exitCode: 0, output: `${stdout}${stderr}`.trim().slice(0, OUTPUT_CAP) };
  } catch (err) {
    const e = err as { code?: number | string; stdout?: string; stderr?: string; message?: string };
    const exitCode = typeof e.code === "number" ? e.code : null;
    const output = `${e.stdout ?? ""}${e.stderr ?? ""}`.trim() || e.message || "command failed";
    return { exitCode, output: output.slice(0, OUTPUT_CAP) };
  }
}

// ---------- result construction ----------

function mkGrounding(now: number, command: string | undefined, ran: boolean, passed: boolean | null): Grounding {
  return buildGrounding({
    generatedAt: now,
    baseCommit: null,
    sources: [{ kind: "runtime-check", ref: command ?? "internal-check" }],
    analysisQuality: "inferred",
    // A check that actually RAN is runtime evidence (verified on pass, failed on fail).
    verification: !ran ? "none" : passed ? "runtime-verified" : "runtime-failed",
  });
}

function result(
  check: VerificationCheck,
  now: number,
  partial: Pick<VerificationResult, "status" | "exitCode" | "passed" | "outputSummary" | "confidenceImpact"> & { repo?: string; cwd?: string },
): VerificationResult {
  return {
    checkId: check.id,
    kind: check.kind,
    label: check.label,
    command: check.command,
    classification: check.classification,
    repo: partial.repo,
    cwd: partial.cwd,
    status: partial.status,
    exitCode: partial.exitCode,
    passed: partial.passed,
    outputSummary: partial.outputSummary,
    ranAt: now,
    confidenceImpact: partial.confidenceImpact,
    grounding: mkGrounding(now, check.command, partial.status === "ran", partial.passed),
  };
}

// ---------- safe-auto checks (the always-run set) ----------

const TOOL_PROBES: { name: string; cmd: string }[] = [
  { name: "node", cmd: "node --version" },
  { name: "npm", cmd: "npm --version" },
  { name: "python", cmd: "python3 --version" },
  { name: "uv", cmd: "uv --version" },
  { name: "docker", cmd: "docker --version" },
  { name: "git", cmd: "git --version" },
];

/** Does a repo look like its deps are installed? Read-only existence checks only. */
function depsInstalled(repoRoot: string): { installed: boolean | null; detail: string } {
  const hasPkg = existsSync(join(repoRoot, "package.json"));
  const hasPy = existsSync(join(repoRoot, "pyproject.toml")) || existsSync(join(repoRoot, "requirements.txt"));
  if (hasPkg) {
    return existsSync(join(repoRoot, "node_modules"))
      ? { installed: true, detail: "node_modules present" }
      : { installed: false, detail: "package.json but no node_modules — run install" };
  }
  if (hasPy) {
    const venv = existsSync(join(repoRoot, ".venv")) || existsSync(join(repoRoot, "venv"));
    return venv ? { installed: true, detail: ".venv present" } : { installed: null, detail: "python project, no local .venv detected (may use a global/uv env)" };
  }
  return { installed: null, detail: "no recognized package manifest" };
}

export interface VerifyOptions {
  generatedAt: number;
  /** Repo roots to run env-file/deps checks against (defaults to indexed repos). */
  repoRoots?: { name: string; rootPath: string }[];
  /** A specific command to verify (subject to classification + confirmation). */
  runCommand?: { repo: string; command: string };
  /** The user explicitly confirmed confirm-required checks. */
  confirmed?: boolean;
}

/**
 * Run the safe-auto suite (tool versions, deps-installed, env-file existence)
 * plus — if a runCommand is supplied — classify it and run/skip/block accordingly.
 */
export async function runVerification(ws: WorkspaceIntel, opts: VerifyOptions): Promise<VerificationStore> {
  const now = opts.generatedAt;
  const roots = opts.repoRoots ?? ws.repos.map((r) => ({ name: r.name, rootPath: r.rootPath }));
  const results: VerificationResult[] = [];

  // 1) tool versions (safe-auto)
  for (const p of TOOL_PROBES) {
    const check: VerificationCheck = { id: `tool:${p.name}`, kind: "tool-version", label: `${p.name} version`, command: p.cmd, classification: "safe-auto", reason: "read-only version probe" };
    const out = await runBounded(p.cmd, process.cwd());
    const passed = out.exitCode === 0;
    results.push(result(check, now, { status: "ran", exitCode: out.exitCode, passed, outputSummary: passed ? out.output.split(/\r?\n/)[0] : "not found", confidenceImpact: passed ? "raises" : "none" }));
  }

  // 2) per-repo: deps-installed + env-file existence (safe-auto, no commands)
  for (const root of roots) {
    const repoIntel = ws.repos.find((r) => r.name === root.name);

    const deps = depsInstalled(root.rootPath);
    results.push(
      result(
        { id: `deps:${root.name}`, kind: "deps-installed", label: `${root.name} dependencies installed`, classification: "safe-auto", reason: "read-only filesystem check" },
        now,
        { repo: root.name, cwd: root.rootPath, status: "ran", exitCode: deps.installed === true ? 0 : deps.installed === false ? 1 : null, passed: deps.installed, outputSummary: deps.detail, confidenceImpact: deps.installed ? "raises" : deps.installed === false ? "lowers" : "none" },
      ),
    );

    // env files the index expects (from envFiles findings) — existence check
    const envFiles = repoIntel?.envFiles.map((e) => e.value) ?? [];
    for (const ef of envFiles) {
      if (/\.(example|template)$/.test(ef)) continue; // examples are committed; check the REAL env
      const present = existsSync(join(root.rootPath, ef));
      results.push(
        result(
          { id: `env:${root.name}:${ef}`, kind: "env-file", label: `${root.name} ${ef} exists`, classification: "safe-auto", reason: "read-only existence check (values never read, S6)" },
          now,
          { repo: root.name, cwd: root.rootPath, status: "ran", exitCode: present ? 0 : 1, passed: present, outputSummary: present ? `${ef} present` : `${ef} missing — setup may be incomplete`, confidenceImpact: present ? "raises" : "lowers" },
        ),
      );
    }
  }

  // 3) explicit command (classified; run / skip / block)
  if (opts.runCommand) {
    const { repo, command } = opts.runCommand;
    const { classification, reason } = classifyCommand(command);
    const root = roots.find((r) => r.name === repo);
    const cwd = root?.rootPath ?? process.cwd();
    const check: VerificationCheck = {
      id: `cmd:${repo}:${command}`,
      kind: CONFIRM_PATTERNS.some((re) => re.test(command)) ? "test-command" : "safe-command",
      label: `${repo}: ${command}`,
      command,
      classification,
      reason,
    };

    if (classification === "blocked") {
      results.push(result(check, now, { repo, cwd, status: "blocked", exitCode: null, passed: null, outputSummary: `BLOCKED — ${reason}`, confidenceImpact: "none" }));
    } else if (classification === "confirm-required" && !opts.confirmed) {
      results.push(result(check, now, { repo, cwd, status: "skipped", exitCode: null, passed: null, outputSummary: `skipped — ${reason}. Re-run with --confirm to execute.`, confidenceImpact: "none" }));
    } else {
      const out = await runBounded(command, cwd);
      const passed = out.exitCode === 0;
      results.push(result(check, now, { repo, cwd, status: "ran", exitCode: out.exitCode, passed, outputSummary: out.output || (passed ? "ok" : "failed"), confidenceImpact: passed ? "raises" : "lowers" }));
    }
  }

  return { generatedAt: now, scanVersion: ws.scanVersion, results };
}

/** Merge a fresh store onto a prior one (by checkId), keeping the latest result each. */
export function mergeVerificationStores(prev: VerificationStore | null, next: VerificationStore): VerificationStore {
  const byId = new Map<string, VerificationResult>();
  for (const r of prev?.results ?? []) byId.set(r.checkId, r);
  for (const r of next.results) byId.set(r.checkId, r); // newer wins
  return { generatedAt: next.generatedAt, scanVersion: next.scanVersion, results: [...byId.values()] };
}

/** Lookup: was a given command verified-passing in the store? (used by command book / change report) */
export function commandVerification(store: VerificationStore | null, repo: string, command: string): VerificationResult | null {
  if (!store) return null;
  return store.results.find((r) => r.repo === repo && r.command === command && r.status === "ran") ?? null;
}
