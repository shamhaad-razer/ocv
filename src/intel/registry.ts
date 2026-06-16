// Target Project Registry (roadmap R2, prompt 26). Pure + host-only.
//
// Lets OpenClaw REMEMBER external target projects so the user can scan/explain by
// a short project id instead of retyping absolute paths. The registry is HOST
// metadata: it lives under ~/.openclaw-intel/, NEVER inside any target project,
// and registering/removing a target only edits this host file — it never touches
// the target's files (HOST_VS_TARGET_PROJECT_MODEL.md).
//
// This module is intentionally I/O-light and dependency-free (only node builtins)
// so it stays testable and host-independent. Git/repo-type detection is supplied
// BY THE CALLER (the CLI already has detectRepos/readGitInfo) and passed in.

import { constants, accessSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { hostStorageDir, projectIdFor } from "./storage.js";

// Storage-path derivation now lives in storage.ts (the single source of truth);
// re-export for back-compat with existing callers/tests.
export { projectIdFor };
export const storageDirFor = hostStorageDir;

/** A registered external target project (host-side metadata only). */
export interface TargetProject {
  /** Stable id derived from the absolute path (survives renames of displayName). */
  id: string;
  /** Human-friendly name (defaults to the path basename; user-editable). */
  displayName: string;
  /** Absolute path of the external target project (read-only to OpenClaw). */
  targetPath: string;
  /** "single-repo" = the path itself is a repo; "multi-repo" = a parent of repos. */
  repoType: "single-repo" | "multi-repo" | "unknown";
  /** Repo names detected under the target (["."] for single-repo). */
  repos: string[];
  /** epoch ms when first registered. */
  createdAt: number;
  /** epoch ms of the last successful scan, or null if never scanned. */
  lastScannedAt: number | null;
  /** Per-repo last-known commit hashes captured at scan time. */
  lastCommits: { repo: string; commit: string | null }[];
  /** Where OpenClaw writes this target's intelligence (HOST storage). */
  storageDir: string;
  /** Optional user description. */
  description?: string;
  /** Count of open known-unknowns at last scan (quick health signal). */
  knownUnknownsSummary: { total: number; byImpact: { high: number; medium: number; low: number } } | null;
}

export interface Registry {
  version: 1;
  projects: TargetProject[];
}

/** The HOST registry file location. Never inside a target project. */
export function registryPath(): string {
  return join(homedir(), ".openclaw-intel", "registry.json");
}

/** Load the registry, or an empty one if absent/corrupt. Read-only. */
export function loadRegistry(path = registryPath()): Registry {
  if (!existsSync(path)) return { version: 1, projects: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as Registry;
    if (parsed && parsed.version === 1 && Array.isArray(parsed.projects)) return parsed;
  } catch {
    /* fall through to empty */
  }
  return { version: 1, projects: [] };
}

/** Persist the registry to HOST storage (creating the dir). */
export function saveRegistry(reg: Registry, path = registryPath()): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(reg, null, 2), "utf-8");
}

/** Validate a target path is usable. Returns an error string or null. Read-only. */
export function validateTargetPath(targetPath: string): string | null {
  if (!existsSync(targetPath)) return `path does not exist: ${targetPath}`;
  let st;
  try {
    st = statSync(targetPath);
  } catch (err) {
    return `path not accessible: ${targetPath} (${(err as Error).message})`;
  }
  if (!st.isDirectory()) return `path is not a directory: ${targetPath}`;
  // readability probe (read-only — R_OK only, never write):
  try {
    accessSync(targetPath, constants.R_OK);
  } catch {
    return `path not readable: ${targetPath}`;
  }
  return null;
}

export interface RegisterInput {
  targetPath: string; // absolute
  displayName?: string;
  description?: string;
  repoType: TargetProject["repoType"];
  repos: string[];
  now: number;
}

/**
 * Add or update a target in the registry (idempotent by id). Returns the entry.
 * Pure transform over the registry object — caller persists with saveRegistry.
 */
export function upsertTarget(reg: Registry, input: RegisterInput): TargetProject {
  const id = projectIdFor(input.targetPath);
  const existing = reg.projects.find((p) => p.id === id);
  const entry: TargetProject = existing
    ? {
        ...existing,
        // refresh detected facts but keep createdAt + user fields
        displayName: input.displayName ?? existing.displayName,
        description: input.description ?? existing.description,
        repoType: input.repoType,
        repos: input.repos,
      }
    : {
        id,
        displayName: input.displayName ?? (input.targetPath.split("/").filter(Boolean).pop() || id),
        targetPath: input.targetPath,
        repoType: input.repoType,
        repos: input.repos,
        createdAt: input.now,
        lastScannedAt: null,
        lastCommits: [],
        storageDir: storageDirFor(input.targetPath),
        description: input.description,
        knownUnknownsSummary: null,
      };
  if (existing) {
    reg.projects = reg.projects.map((p) => (p.id === id ? entry : p));
  } else {
    reg.projects.push(entry);
  }
  return entry;
}

/** Record a completed scan against a registered target (commits + unknowns + time). */
export function recordScan(
  reg: Registry,
  targetPath: string,
  now: number,
  lastCommits: { repo: string; commit: string | null }[],
  knownUnknownsSummary: TargetProject["knownUnknownsSummary"],
): void {
  const id = projectIdFor(targetPath);
  const entry = reg.projects.find((p) => p.id === id);
  if (!entry) return;
  entry.lastScannedAt = now;
  entry.lastCommits = lastCommits;
  entry.knownUnknownsSummary = knownUnknownsSummary;
}

/** Resolve a registry reference (id OR displayName OR absolute path) to an entry. */
export function resolveTarget(reg: Registry, ref: string): TargetProject | null {
  return (
    reg.projects.find((p) => p.id === ref) ??
    reg.projects.find((p) => p.displayName === ref) ??
    reg.projects.find((p) => p.targetPath === ref) ??
    null
  );
}

/** Remove a target from tracking. Returns true if removed. Does NOT touch the target. */
export function removeTarget(reg: Registry, ref: string): TargetProject | null {
  const entry = resolveTarget(reg, ref);
  if (!entry) return null;
  reg.projects = reg.projects.filter((p) => p.id !== entry.id);
  return entry;
}
