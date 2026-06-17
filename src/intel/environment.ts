// Local Environment Profile + Command Compatibility (07-...md §2, prompt 39).
//
// THE problem this solves: OpenClaw shouldn't forget whether the user is on WSL,
// native Windows, macOS, or Linux — and it should suggest commands that actually
// fit that machine. This module owns a PERSISTENT, host-side `EnvironmentProfile`:
//   - it wraps the safe read-only `MachineEnv` probes (env.ts) with a normalized
//     OS variant + working dirs + USER OVERRIDES that survive a refresh;
//   - it persists to HOST storage (~/.openclaw-intel/environment.json), NEVER
//     inside a target project (HOST_VS_TARGET_PROJECT_MODEL.md);
//   - it classifies environment checks by safety (safe-auto / confirm / blocked)
//     reusing the single classifier in verify.ts, so detection only ever runs
//     read-only probes automatically (req #3);
//   - it answers "does this command fit my machine?" (command compatibility).
//
// `ocv` owns local machine access, so detection lives here. Detection is the
// safe-probe path from env.ts (version flags, uname) — nothing is installed, no
// service is started, no target is touched.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { detectMachineEnv, toolForCommand } from "./env.js";
import { classifyCommand } from "./verify.js";
import { hostIntelRoot } from "./storage.js";
import type {
  CheckClassification,
  EnvironmentProfile,
  KnownUnknown,
  MachineEnv,
  OsVariant,
} from "./types.js";

/** The persistent profile lives at the HOST intel root — one per machine. */
export function environmentProfilePath(): string {
  return join(hostIntelRoot(), "environment.json");
}

/** Normalize a detected MachineEnv into the coarse OS variant we reason about. */
export function osVariantOf(machine: MachineEnv): OsVariant {
  if (machine.os === "win32") return "windows";
  if (machine.os === "darwin") return "macos";
  if (machine.os === "linux") return machine.isWSL ? "wsl" : "linux";
  return "unknown";
}

/** The effective OS variant = a user override if set, else detection. */
export function effectiveOsVariant(profile: EnvironmentProfile): OsVariant {
  return profile.overrides.osVariant ?? profile.osVariant;
}

/** The effective shell = a user override if set, else the detected shell. */
export function effectiveShell(profile: EnvironmentProfile): string | null {
  return profile.overrides.shell ?? profile.machine.shell;
}

/**
 * Detect the local environment (SAFE probes only) and build a profile. Existing
 * user overrides + working dirs are CARRIED FORWARD so a refresh never silently
 * discards a manually-pinned shell/variant (req #6).
 */
export async function detectEnvironmentProfile(
  now: number,
  prev?: EnvironmentProfile | null,
): Promise<{ profile: EnvironmentProfile; unknowns: KnownUnknown[] }> {
  const { env, unknowns } = await detectMachineEnv({ generatedAt: now });
  const profile: EnvironmentProfile = {
    version: 1,
    osVariant: osVariantOf(env),
    machine: env,
    workingDirs: prev?.workingDirs ?? [],
    overrides: prev?.overrides ?? {},
    refreshedAt: now,
    updatedAt: now,
  };
  return { profile, unknowns };
}

/** Load the persisted profile, or null if none yet. Read-only, never throws. */
export function loadEnvironmentProfile(path = environmentProfilePath()): EnvironmentProfile | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as EnvironmentProfile;
    if (parsed && parsed.version === 1 && parsed.machine) return parsed;
  } catch {
    /* fall through */
  }
  return null;
}

/** Persist the profile to HOST storage (creating the dir). */
export function saveEnvironmentProfile(profile: EnvironmentProfile, path = environmentProfilePath()): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(profile, null, 2), "utf-8");
}

/** Fields a user may manually set (req #6). Overrides persist across refreshes. */
export interface EnvironmentOverrideUpdate {
  osVariant?: OsVariant;
  shell?: string;
  commandStyle?: string;
  /** Add a working directory the user cares about. */
  addWorkingDir?: string;
}

/** Apply a manual override to the profile (pure transform; stamps updatedAt). */
export function applyEnvironmentOverride(profile: EnvironmentProfile, update: EnvironmentOverrideUpdate, now: number): EnvironmentProfile {
  const overrides = { ...profile.overrides };
  if (update.osVariant !== undefined) overrides.osVariant = update.osVariant;
  if (update.shell !== undefined) overrides.shell = update.shell;
  if (update.commandStyle !== undefined) overrides.commandStyle = update.commandStyle;
  const workingDirs = update.addWorkingDir
    ? [...new Set([...profile.workingDirs, update.addWorkingDir])]
    : profile.workingDirs;
  return { ...profile, overrides, workingDirs, updatedAt: now };
}

// ---------------------------------------------------------------------------
// Environment-check safety classification (req #3)
// ---------------------------------------------------------------------------

/**
 * Classify an environment check by safety, reusing verify.ts's single classifier
 * (the one source of truth shared with the command book + runtime verification).
 * Detection ONLY ever runs `safe-auto` checks automatically; anything that could
 * modify the machine is `confirm-required`; installs / service-starts are
 * `blocked` from auto-running (req #3).
 */
export function classifyEnvCheck(command: string): { classification: CheckClassification; reason: string } {
  return classifyCommand(command);
}

/** The exact read-only probes the profile runs automatically (all safe-auto). */
export function autoProbes(): { command: string; classification: CheckClassification }[] {
  const probes = [
    "node --version", "npm --version", "pnpm --version", "yarn --version",
    "python3 --version", "pip3 --version", "poetry --version", "uv --version",
    "docker --version", "git --version", "make --version",
  ];
  return probes.map((command) => ({ command, classification: classifyCommand(command).classification }));
}

// ---------------------------------------------------------------------------
// Command compatibility (req: "command recommendations can mention compatibility")
// ---------------------------------------------------------------------------

export interface CommandCompatibility {
  command: string;
  /** "compatible" = prereqs present; "missing-tool" = needed tool absent; "shell-mismatch" = wrong shell style; "unknown" = can't tell. */
  status: "compatible" | "missing-tool" | "shell-mismatch" | "unknown";
  /** The tool the command needs, if identifiable. */
  tool: string | null;
  /** Whether that tool is present on this machine. */
  toolPresent: boolean | null;
  /** A human note suitable to show next to the command. */
  note: string;
}

/**
 * Decide whether a command fits this machine, using the profile. This is what lets
 * recommendations "mention compatibility": missing tool → flag + suggest install;
 * PowerShell-style command on a POSIX shell (or vice-versa) → flag a shell mismatch.
 * It NEVER runs the command — pure analysis over the profile.
 */
export function commandCompatibility(command: string, profile: EnvironmentProfile): CommandCompatibility {
  const variant = effectiveOsVariant(profile);
  const tool = toolForCommand(command);
  const toolCheck = tool ? profile.machine.tools.find((t) => t.name === tool) : undefined;
  const toolPresent = toolCheck ? toolCheck.available : tool ? false : null;

  // Shell-style mismatch heuristic: PowerShell cmdlets on POSIX, or `$env:`/backslash
  // paths where a POSIX shell is in use (wsl/linux/macos), and vice-versa.
  const posix = variant === "wsl" || variant === "linux" || variant === "macos";
  const looksPowerShell = /(^|\s)(Get-|Set-|New-|Remove-)\w+|\$env:|\\[A-Za-z]/.test(command);
  if (posix && looksPowerShell) {
    return {
      command,
      status: "shell-mismatch",
      tool,
      toolPresent,
      note: `Looks like a PowerShell/Windows command, but this machine is ${variant} (POSIX shell ${effectiveShell(profile) ?? "?"}). Use the POSIX form.`,
    };
  }
  if (variant === "windows" && /(^|\s)(ls|cat|rm -rf|export \w+=|source )/.test(command)) {
    return {
      command,
      status: "shell-mismatch",
      tool,
      toolPresent,
      note: `Looks like a POSIX/Unix command, but this machine is native Windows. Use the PowerShell/cmd form (or run under WSL).`,
    };
  }

  if (tool && toolPresent === false) {
    return {
      command,
      status: "missing-tool",
      tool,
      toolPresent: false,
      note: `Needs \`${tool}\`, which was NOT detected on this machine — install it first (this won't be auto-run).`,
    };
  }
  if (tool && toolPresent === true) {
    const v = toolCheck?.version ? ` ${toolCheck.version}` : "";
    return { command, status: "compatible", tool, toolPresent: true, note: `\`${tool}\`${v} is present — compatible with this ${variant} machine.` };
  }
  return { command, status: "unknown", tool, toolPresent, note: `No specific tool requirement detected; assumed runnable on this ${variant} machine (unverified).` };
}

/** A one-line, human-readable summary of the profile for chat/CLI display. */
export function summarizeProfile(profile: EnvironmentProfile): string {
  const variant = effectiveOsVariant(profile);
  const overridden = profile.overrides.osVariant ? " (user-set)" : "";
  const shell = effectiveShell(profile) ?? "unknown";
  const present = profile.machine.tools.filter((t) => t.available);
  const missing = profile.machine.tools.filter((t) => !t.available);
  return (
    `${variant}${overridden} · shell ${shell} · arch ${profile.machine.arch}. ` +
    `Tools present: ${present.map((t) => `${t.name}${t.version ? ` ${t.version}` : ""}`).join(", ") || "none"}. ` +
    (missing.length ? `Not found: ${missing.map((t) => t.name).join(", ")}.` : "All probed tools present.")
  );
}
