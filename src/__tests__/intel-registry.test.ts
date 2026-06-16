import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  loadRegistry,
  saveRegistry,
  upsertTarget,
  recordScan,
  resolveTarget,
  removeTarget,
  projectIdFor,
  storageDirFor,
  validateTargetPath,
} from "../intel/registry.js";

const NOW = 1_700_000_000_000;

describe("registry — pure CRUD", () => {
  let regPath: string;
  beforeEach(() => {
    regPath = join(mkdtempSync(join(tmpdir(), "reg-")), "registry.json");
  });
  afterEach(() => rmSync(join(regPath, ".."), { recursive: true, force: true }));

  it("starts empty and round-trips through save/load", () => {
    const reg = loadRegistry(regPath);
    expect(reg.projects).toEqual([]);
    upsertTarget(reg, { targetPath: "/tmp/p1", repoType: "single-repo", repos: ["p1"], now: NOW });
    saveRegistry(reg, regPath);
    expect(existsSync(regPath)).toBe(true);
    const reloaded = loadRegistry(regPath);
    expect(reloaded.projects).toHaveLength(1);
    expect(reloaded.projects[0].targetPath).toBe("/tmp/p1");
  });

  it("derives a stable id from the path and a host storage dir", () => {
    expect(projectIdFor("/tmp/p1")).toBe(projectIdFor("/tmp/p1"));
    expect(projectIdFor("/tmp/p1")).not.toBe(projectIdFor("/tmp/p2"));
    expect(storageDirFor("/tmp/p1")).toContain(".openclaw-intel");
    expect(storageDirFor("/tmp/p1")).not.toContain("/tmp/p1/"); // never inside target
  });

  it("upsert is idempotent by id and preserves createdAt", () => {
    const reg = loadRegistry(regPath);
    const a = upsertTarget(reg, { targetPath: "/tmp/p1", repoType: "single-repo", repos: ["p1"], now: NOW, displayName: "First" });
    const b = upsertTarget(reg, { targetPath: "/tmp/p1", repoType: "multi-repo", repos: ["a", "b"], now: NOW + 999, displayName: "Renamed" });
    expect(reg.projects).toHaveLength(1);
    expect(b.id).toBe(a.id);
    expect(b.createdAt).toBe(NOW); // preserved
    expect(b.repoType).toBe("multi-repo"); // refreshed
    expect(b.displayName).toBe("Renamed");
  });

  it("recordScan stores commits + unknowns summary + timestamp", () => {
    const reg = loadRegistry(regPath);
    upsertTarget(reg, { targetPath: "/tmp/p1", repoType: "single-repo", repos: ["p1"], now: NOW });
    recordScan(reg, "/tmp/p1", NOW + 5, [{ repo: "p1", commit: "abc123" }], { total: 3, byImpact: { high: 1, medium: 2, low: 0 } });
    const p = reg.projects[0];
    expect(p.lastScannedAt).toBe(NOW + 5);
    expect(p.lastCommits).toEqual([{ repo: "p1", commit: "abc123" }]);
    expect(p.knownUnknownsSummary?.total).toBe(3);
  });

  it("resolves by id, displayName, or path", () => {
    const reg = loadRegistry(regPath);
    const e = upsertTarget(reg, { targetPath: "/tmp/p1", repoType: "single-repo", repos: ["p1"], now: NOW, displayName: "Widget" });
    expect(resolveTarget(reg, e.id)?.id).toBe(e.id);
    expect(resolveTarget(reg, "Widget")?.id).toBe(e.id);
    expect(resolveTarget(reg, "/tmp/p1")?.id).toBe(e.id);
    expect(resolveTarget(reg, "nope")).toBeNull();
  });

  it("removeTarget untracks without affecting anything else", () => {
    const reg = loadRegistry(regPath);
    upsertTarget(reg, { targetPath: "/tmp/p1", repoType: "single-repo", repos: ["p1"], now: NOW });
    upsertTarget(reg, { targetPath: "/tmp/p2", repoType: "single-repo", repos: ["p2"], now: NOW });
    const removed = removeTarget(reg, "/tmp/p1");
    expect(removed?.targetPath).toBe("/tmp/p1");
    expect(reg.projects.map((p) => p.targetPath)).toEqual(["/tmp/p2"]);
    expect(removeTarget(reg, "nope")).toBeNull();
  });
});

describe("validateTargetPath", () => {
  it("rejects non-existent / non-directory, accepts a real dir", () => {
    expect(validateTargetPath("/no/such/path/xyz")).toMatch(/does not exist/);
    const dir = mkdtempSync(join(tmpdir(), "vt-"));
    const file = join(dir, "f.txt");
    writeFileSync(file, "x");
    try {
      expect(validateTargetPath(file)).toMatch(/not a directory/);
      expect(validateTargetPath(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// Loading a corrupt registry must not throw — it falls back to empty.
describe("registry resilience", () => {
  it("returns empty on corrupt JSON", () => {
    const dir = mkdtempSync(join(tmpdir(), "reg-bad-"));
    const p = join(dir, "registry.json");
    writeFileSync(p, "{ not json");
    try {
      expect(loadRegistry(p).projects).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// Sanity: registry never embeds inside a target path.
describe("host-storage invariant", () => {
  it("storageDir for a target is under ~/.openclaw-intel, not the target", () => {
    const sd = storageDirFor("/some/external/project");
    expect(sd.startsWith("/some/external/project")).toBe(false);
    expect(sd).toContain(".openclaw-intel");
  });
});
