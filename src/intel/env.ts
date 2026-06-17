// Local environment awareness (milestone 4, 07-command-and-setup-assistant.md §2).
//
// Detects enough about the user's machine to avoid suggesting incompatible setup
// commands. SAFETY IS THE WHOLE POINT:
//   - only ALLOWLISTED, read-only, fast probes run automatically (version flags,
//     `uname`, env-file existence) — these are §7 "auto-run" safe checks;
//   - port checks are OPT-IN (requireConfirmation) — they may touch the network;
//   - nothing is ever installed; no dev server is started; no mutating command runs.
//
// `ocv` owns local machine access (03-extension-architecture.md), so this lives in
// ocv. The standalone CLI is a normal Node process and can run these probes today;
// whether the PLUGIN runtime can exec is OQ2 — so every probe is wrapped in a
// try/catch and a failure becomes "not available" + a known-unknown, never a crash
// and never a false claim.

import { execFileSync } from "node:child_process";
import { release } from "node:os";
import { createServer } from "node:net";
import { buildGrounding } from "./grounding.js";
import type {
  Grounding,
  KnownUnknown,
  MachineEnv,
  PortCheck,
  SetupCompatibility,
  ToolCheck,
  WorkspaceIntel,
} from "./types.js";

/** Run a short, read-only command with a hard timeout. Returns trimmed stdout or null. */
function safeProbe(cmd: string, args: string[]): string | null {
  try {
    return execFileSync(cmd, args, {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3000, // never hang the scan
    }).trim();
  } catch {
    return null;
  }
}

/** The allowlist of tools we probe — all version/identity flags, all read-only. */
const TOOL_PROBES: { name: string; cmd: string; args: string[] }[] = [
  { name: "node", cmd: "node", args: ["--version"] },
  { name: "npm", cmd: "npm", args: ["--version"] },
  { name: "pnpm", cmd: "pnpm", args: ["--version"] },
  { name: "yarn", cmd: "yarn", args: ["--version"] },
  { name: "python", cmd: "python3", args: ["--version"] },
  { name: "pip", cmd: "pip3", args: ["--version"] },
  { name: "poetry", cmd: "poetry", args: ["--version"] },
  { name: "uv", cmd: "uv", args: ["--version"] },
  { name: "docker", cmd: "docker", args: ["--version"] },
  { name: "git", cmd: "git", args: ["--version"] },
  { name: "make", cmd: "make", args: ["--version"] },
];

export interface EnvOptions {
  generatedAt: number;
  /** Opt-in: check whether these ports are occupied (requires user confirmation). */
  checkPorts?: number[];
}

function firstVersionToken(out: string): string {
  // e.g. "git version 2.43.0" -> "2.43.0"; "v24.15.0" -> "v24.15.0"
  const m = out.match(/v?\d+\.\d+(\.\d+)?/);
  return m ? m[0] : out.split(/\r?\n/)[0];
}

/** Detect a single tool via its safe probe. A hit is runtime-verified. */
function checkTool(probe: { name: string; cmd: string; args: string[] }, now: number): ToolCheck {
  const probeStr = `${probe.cmd} ${probe.args.join(" ")}`;
  const out = safeProbe(probe.cmd, probe.args);
  const available = out !== null;
  const grounding: Grounding = buildGrounding({
    generatedAt: now,
    baseCommit: null,
    sources: [{ kind: "runtime-check", ref: probeStr, locator: probe.name }],
    analysisQuality: "inferred",
    // A successful probe IS runtime verification → high confidence; a miss is a
    // verified-absent fact (also runtime-verified, just negative).
    verification: "runtime-verified",
  });
  return {
    name: probe.name,
    available,
    version: available ? firstVersionToken(out as string) : undefined,
    probe: probeStr,
    grounding,
  };
}

/** Detect WSL from the kernel release string (read-only). */
function detectWSL(): boolean {
  try {
    // os.release() includes "microsoft" / "WSL" under WSL2.
    return /microsoft|wsl/i.test(release());
  } catch {
    return false;
  }
}

/**
 * Opt-in, confirmation-gated port check. Attempts a short-lived local bind; if it
 * fails with EADDRINUSE the port is occupied. Pure-local (127.0.0.1), no network
 * egress, server is closed immediately. Async to avoid busy-waiting.
 */
async function checkPort(port: number, now: number): Promise<PortCheck> {
  const state: PortCheck["state"] = await new Promise((resolve) => {
    const server = createServer();
    server.once("error", (err: NodeJS.ErrnoException) => {
      resolve(err.code === "EADDRINUSE" ? "occupied" : "unknown");
    });
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve("free"));
    });
  });
  return {
    port,
    state,
    grounding: buildGrounding({
      generatedAt: now,
      baseCommit: null,
      sources: [{ kind: "runtime-check", ref: `port-check:${port}` }],
      analysisQuality: "inferred",
      verification: state === "unknown" ? "runtime-failed" : "runtime-verified",
    }),
  };
}

/**
 * Detect the local machine environment via safe probes. Returns the MachineEnv
 * plus any known-unknowns (missing tools, unverified ports).
 */
export async function detectMachineEnv(opts: EnvOptions): Promise<{ env: MachineEnv; unknowns: KnownUnknown[] }> {
  const now = opts.generatedAt;
  const unknowns: KnownUnknown[] = [];

  const os = process.platform;
  const isWSL = os === "linux" && detectWSL();
  const shell = process.env.SHELL ?? (os === "win32" ? process.env.ComSpec ?? null : null);
  const arch = process.arch;

  const tools = TOOL_PROBES.map((p) => checkTool(p, now));

  // Missing common tools become queryable known-unknowns (don't fail, don't guess).
  for (const t of tools) {
    if (!t.available && ["node", "git"].includes(t.name)) {
      unknowns.push({
        id: `env:missing-tool:${t.name}`,
        kind: "missing-tool",
        title: `${t.name} not found on PATH`,
        detail: `Probe \`${t.probe}\` returned nothing; commands needing ${t.name} can't be recommended for this machine.`,
        evidence: [{ kind: "runtime-check", ref: t.probe }],
        status: "open",
        confidenceImpact: "medium",
      });
    }
  }

  let ports: PortCheck[] = [];
  if (opts.checkPorts && opts.checkPorts.length) {
    ports = await Promise.all(opts.checkPorts.map((p) => checkPort(p, now)));
  } else {
    // We did NOT check ports — record that as a missing check, not a clean bill.
    unknowns.push({
      id: "env:unverified-port",
      kind: "unverified-port",
      title: "ports not checked",
      detail: "Port availability was not probed (opt-in via `env --check-ports`); whether dev ports are free is unverified.",
      evidence: [],
      status: "open",
      confidenceImpact: "low",
    });
  }

  const grounding = buildGrounding({
    generatedAt: now,
    baseCommit: null,
    sources: [
      { kind: "runtime-check", ref: "process.platform", locator: os },
      { kind: "runtime-check", ref: "os.release", locator: isWSL ? "WSL" : "native" },
    ],
    analysisQuality: "inferred",
    verification: "runtime-verified",
    knownUnknownIds: unknowns.map((u) => u.id),
  });

  return { env: { os, isWSL, shell, arch, tools, ports, grounding }, unknowns };
}

// ---------- setup compatibility (commands ↔ available tools) ----------

/** Infer which tool a command needs from its text (first token + common runners). */
export function toolForCommand(command: string): string | null {
  const first = command.trim().split(/\s+/)[0];
  const map: Record<string, string> = {
    npm: "npm",
    npx: "npm",
    pnpm: "pnpm",
    yarn: "yarn",
    node: "node",
    python: "python",
    python3: "python",
    pip: "python",
    uv: "uv",
    docker: "docker",
    "docker-compose": "docker",
    make: "make",
    git: "git",
  };
  return map[first] ?? null;
}

/**
 * Derive per-repo setup compatibility by intersecting the tools a repo's commands
 * need against the tools detected on the machine. This is what lets the system
 * avoid recommending a command whose tool is missing (07-...md §2).
 */
export function deriveSetupCompatibility(ws: WorkspaceIntel): SetupCompatibility[] {
  const env = ws.machineEnv;
  if (!env) return [];
  const present = new Set(env.tools.filter((t) => t.available).map((t) => t.name));
  const known = new Set(env.tools.map((t) => t.name));

  return ws.repos.map((repo) => {
    const needed = new Set<string>();
    for (const s of repo.scripts) {
      const tool = toolForCommand(s.value.command);
      if (tool) needed.add(tool);
    }
    const toolsPresent: string[] = [];
    const toolsMissing: string[] = [];
    for (const t of needed) {
      if (present.has(t)) toolsPresent.push(t);
      else if (known.has(t)) toolsMissing.push(t); // we probed and it's absent
      // tools we never probe (unknown) are left out rather than claimed missing
    }
    const notes: string[] = [];
    if (env.isWSL) notes.push("Running under WSL: prefer Linux-style paths and the WSL shell, not Windows PowerShell.");
    for (const m of toolsMissing) {
      notes.push(`\`${m}\` not found — commands needing it (and their dependent steps) can't run here until installed.`);
    }
    return { repo: repo.name, toolsPresent: toolsPresent.sort(), toolsMissing: toolsMissing.sort(), notes };
  });
}
