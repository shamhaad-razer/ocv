// Project Intelligence Storage (roadmap R2/R4, prompt 27). Pure + host-only.
//
// THE storage abstraction: every artifact OpenClaw generates about a target goes
// through here, so no feature writes into a target project by accident. Default
// storage is HOST-side and keyed by project id; the target is touched only when
// the user explicitly opts into project-local storage (`--local`), which this
// module supports but never enables by default
// (HOST_VS_TARGET_PROJECT_MODEL.md).
//
// Only node builtins → host-independent + testable. Time/git are injected by the
// caller; this module just decides WHERE artifacts live and reads/writes them.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Stable project id = short hash of the absolute target path. */
export function projectIdFor(targetPath: string): string {
  return createHash("sha256").update(targetPath).digest("hex").slice(0, 12);
}

/** Root of all HOST-side OpenClaw intelligence. Never inside a target. */
export function hostIntelRoot(): string {
  return join(homedir(), ".openclaw-intel");
}

/**
 * Deterministic HOST storage dir for a target: ~/.openclaw-intel/<name>-<id>.
 * Keyed by project id (the path hash); the name prefix is cosmetic for humans.
 */
export function hostStorageDir(targetPath: string): string {
  const id = projectIdFor(targetPath);
  const name = (targetPath.split("/").filter(Boolean).pop() || "target").replace(/[^A-Za-z0-9_-]/g, "_");
  return join(hostIntelRoot(), `${name}-${id}`);
}

/** Project-LOCAL storage dir: <target>/.openclaw. OPT-IN only — modifies the target. */
export function localStorageDir(targetPath: string): string {
  return join(targetPath, ".openclaw");
}

/**
 * Resolve the storage dir for a target. `local` is the explicit opt-in that
 * writes INSIDE the target (the user accepted that). Default is host-side.
 */
export function resolveStorageDir(targetPath: string, opts?: { local?: boolean; explicitOut?: string }): string {
  if (opts?.explicitOut) return opts.explicitOut;
  if (opts?.local) return localStorageDir(targetPath);
  return hostStorageDir(targetPath);
}

/** The canonical artifact filenames. ONE place so nothing hardcodes them. */
export const ARTIFACTS = {
  index: "project-intel.json",
  prevIndex: "project-intel.prev.json",
  map: "project-map.md",
  diff: "project-diff.md",
  changeReportJson: "change-report.json",
  changeReportMd: "change-report.md",
  verification: "verification.json",
  contextPack: "context-pack.json",
  deploymentJson: "deployment-report.json",
  deploymentMd: "deployment-report.md",
  mirrorJson: "mirror-report.json",
  mirrorMd: "mirror-report.md",
  docsDir: "docs",
  reportHistoryDir: "report-history",
  contextHistoryDir: "context-history",
} as const;

export type ArtifactKey = keyof typeof ARTIFACTS;

/** A handle to one target's storage. All reads/writes go through it. */
export class ProjectStorage {
  constructor(readonly dir: string, readonly isLocal: boolean) {}

  /** Build a storage handle for a target (host by default, local if opted in). */
  static for(targetPath: string, opts?: { local?: boolean; explicitOut?: string }): ProjectStorage {
    const dir = resolveStorageDir(targetPath, opts);
    return new ProjectStorage(dir, !opts?.explicitOut && !!opts?.local);
  }

  path(key: ArtifactKey): string {
    return join(this.dir, ARTIFACTS[key]);
  }
  /** Sub-path inside the docs dir. */
  docPath(filename: string): string {
    return join(this.dir, ARTIFACTS.docsDir, filename);
  }
  ensure(): void {
    mkdirSync(this.dir, { recursive: true });
  }
  has(key: ArtifactKey): boolean {
    return existsSync(this.path(key));
  }
  readText(key: ArtifactKey): string | null {
    try {
      return readFileSync(this.path(key), "utf-8");
    } catch {
      return null;
    }
  }
  readJson<T>(key: ArtifactKey): T | null {
    const raw = this.readText(key);
    if (raw == null) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }
  writeText(key: ArtifactKey, content: string): void {
    this.ensure();
    writeFileSync(this.path(key), content, "utf-8");
  }
  writeJson(key: ArtifactKey, value: unknown): void {
    this.writeText(key, JSON.stringify(value, null, 2));
  }
  writeDoc(filename: string, content: string): void {
    mkdirSync(join(this.dir, ARTIFACTS.docsDir), { recursive: true });
    writeFileSync(this.docPath(filename), content, "utf-8");
  }

  /**
   * Append a change report to the per-target report history (req #2 "report
   * history"). Filename is the injected timestamp so history is ordered + never
   * overwritten. The "latest" change-report is still written separately.
   */
  appendReportHistory(stampMs: number, json: unknown, md: string): { jsonPath: string; mdPath: string } {
    const histDir = join(this.dir, ARTIFACTS.reportHistoryDir);
    mkdirSync(histDir, { recursive: true });
    const stamp = String(stampMs);
    const jsonPath = join(histDir, `report-${stamp}.json`);
    const mdPath = join(histDir, `report-${stamp}.md`);
    writeFileSync(jsonPath, JSON.stringify(json, null, 2), "utf-8");
    writeFileSync(mdPath, md, "utf-8");
    return { jsonPath, mdPath };
  }
}
