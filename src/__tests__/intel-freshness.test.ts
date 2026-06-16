import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scanRepo } from "../intel/scanner.js";
import { buildGrounding, hashContent, invalidateGrounding, SCAN_VERSION } from "../intel/grounding.js";
import { invalidateWorkspace } from "../intel/invalidate.js";
import { compareWorkspaces, hasChanges } from "../intel/compare.js";
import type { WorkspaceIntel } from "../intel/types.js";

const FIXED_NOW = 1_700_000_000_000;

function makeRepo(scripts: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "intel-fr-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "r", scripts }));
  writeFileSync(join(dir, "Dockerfile"), "FROM node:20\n");
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src", "server.ts"), 'app.get("/health", () => {});\n');
  return dir;
}

function wsOf(rootPath: string, ...repos: ReturnType<typeof scanRepo>[]): WorkspaceIntel {
  return { rootPath, scanVersion: SCAN_VERSION, generatedAt: FIXED_NOW, repos, knownUnknowns: [] };
}

describe("scan coverage", () => {
  let repo: string;
  beforeEach(() => {
    repo = makeRepo({ test: "vitest run" });
    mkdirSync(join(repo, "node_modules")); // should be skipped
    writeFileSync(join(repo, "node_modules", "junk.js"), "x");
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it("reports files scanned and skips vendored dirs", () => {
    const intel = scanRepo(repo, { generatedAt: FIXED_NOW });
    expect(intel.coverage.filesScanned).toBeGreaterThan(0);
    expect(intel.coverage.dirsScanned).toContain("src");
    expect(intel.coverage.dirsSkipped).toContain("node_modules");
    expect(intel.coverage.truncated).toBe(false);
  });

  it("flags truncation when maxFiles is exceeded", () => {
    const intel = scanRepo(repo, { generatedAt: FIXED_NOW, maxFiles: 1 });
    expect(intel.coverage.truncated).toBe(true);
    expect(intel.knownUnknowns.some((u) => u.title === "scan truncated")).toBe(true);
  });
});

describe("invalidateGrounding", () => {
  it("flips status to potentially-stale AND drops confidence", () => {
    const g = buildGrounding({
      generatedAt: FIXED_NOW,
      baseCommit: "abc",
      sources: [{ kind: "file", ref: "a.ts", hash: hashContent("v1") }],
      analysisQuality: "declared",
    });
    expect(g.confidence).toBe("high");
    const stale = invalidateGrounding(g, "potentially-stale", "source changed: a.ts");
    expect(stale.status).toBe("potentially-stale");
    expect(stale.staleReason).toContain("a.ts");
    // declared+complete but now stale → medium (no longer high)
    expect(stale.confidence).toBe("medium");
    expect(stale.confidenceBasis.freshness).toBe("potentially-stale");
  });

  it("known-stale forces low confidence", () => {
    const g = buildGrounding({
      generatedAt: FIXED_NOW,
      baseCommit: "abc",
      sources: [{ kind: "file", ref: "a.ts", hash: hashContent("v1") }],
      analysisQuality: "declared",
    });
    expect(invalidateGrounding(g, "known-stale", "scanVersion changed").confidence).toBe("low");
  });

  it("re-freshening restores confidence", () => {
    const g = buildGrounding({
      generatedAt: FIXED_NOW,
      baseCommit: "abc",
      sources: [{ kind: "file", ref: "a.ts", hash: hashContent("v1") }],
      analysisQuality: "declared",
    });
    const stale = invalidateGrounding(g, "potentially-stale");
    const fresh = invalidateGrounding(stale, "fresh");
    expect(fresh.status).toBe("fresh");
    expect(fresh.confidence).toBe("high");
    expect(fresh.staleReason).toBeUndefined();
  });
});

describe("invalidateWorkspace (finding-level write-back)", () => {
  let repo: string;
  beforeEach(() => {
    repo = makeRepo({ test: "vitest run" });
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it("marks findings whose source files drift as potentially-stale", () => {
    const intel = scanRepo(repo, { generatedAt: FIXED_NOW });
    const ws = wsOf(repo, intel);

    // No drift → everything stays fresh.
    const clean = invalidateWorkspace(ws, (r, ref) => {
      // return the SAME hash that was recorded
      const all = [...r.packageFiles, ...r.scripts, ...r.deployFiles, ...r.routes];
      const found = all.find((f) => f.grounding.fileHashes.some((h) => h.ref === ref));
      return found?.grounding.fileHashes.find((h) => h.ref === ref)?.hash ?? null;
    });
    expect(clean.summaries[0].staleFindings).toBe(0);

    // Simulate package.json drift → its findings go stale.
    const drifted = invalidateWorkspace(ws, (_r, ref) =>
      ref === "package.json" ? "deadbeefdeadbeef" : "same",
    );
    // package.json finding + scripts (cited from package.json) should be stale.
    const pkg = drifted.workspace.repos[0].packageFiles.find((p) => p.value === "package.json");
    expect(pkg?.grounding.status).toBe("potentially-stale");
    expect(drifted.summaries[0].staleFindings).toBeGreaterThan(0);
  });
});

describe("compareWorkspaces", () => {
  let repo: string;
  beforeEach(() => {
    repo = makeRepo({ test: "vitest run", lint: "eslint ." });
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it("detects added, removed, and changed scripts", () => {
    const prevIntel = scanRepo(repo, { generatedAt: FIXED_NOW });
    const prev = wsOf(repo, prevIntel);

    // mutate manifest: drop lint, change test, add build
    writeFileSync(
      join(repo, "package.json"),
      JSON.stringify({ name: "r", scripts: { test: "vitest run --coverage", build: "tsc" } }),
    );
    const nextIntel = scanRepo(repo, { generatedAt: FIXED_NOW + 1000 });
    const next = wsOf(repo, nextIntel);

    const diff = compareWorkspaces(prev, next);
    expect(hasChanges(diff)).toBe(true);
    const deltas = diff.repoDiffs[0].deltas.filter((d) => d.section === "scripts");
    const byChange = (c: string) => deltas.filter((d) => d.change === c).map((d) => d.key);
    expect(byChange("added")).toContain("build");
    expect(byChange("removed")).toContain("lint");
    expect(byChange("changed")).toContain("test");
  });

  it("reports no changes for identical scans", () => {
    const a = scanRepo(repo, { generatedAt: FIXED_NOW });
    const diff = compareWorkspaces(wsOf(repo, a), wsOf(repo, a));
    expect(hasChanges(diff)).toBe(false);
  });
});
