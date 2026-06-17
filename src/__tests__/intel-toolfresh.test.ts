import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scanRepo } from "../intel/scanner.js";
import { buildDashboard } from "../intel/dashboard.js";
import { detectToolOpportunities } from "../intel/tooldetect.js";
import { generateTool } from "../intel/toolgen.js";
import { checkToolsFreshness, regenerateTools } from "../intel/toolfresh.js";
import { hashFile, SCAN_VERSION } from "../intel/grounding.js";
import type { TargetProject } from "../intel/registry.js";
import type { GeneratedToolSpec, GeneratedToolsIndex, ToolType, WorkspaceIntel } from "../intel/types.js";

const NOW = 1_700_000_000_000;

function project(id: string, targetPath: string): TargetProject {
  return { id, displayName: id, targetPath, repoType: "single-repo", repos: [id], createdAt: NOW, lastScannedAt: NOW, lastCommits: [], storageDir: `/host/${id}`, knownUnknownsSummary: null, freshness: { overall: "fresh", checkedAt: NOW } };
}

function scan(root: string): WorkspaceIntel {
  const intel = scanRepo(root, { generatedAt: NOW });
  return { rootPath: root, targetPath: root, scanVersion: SCAN_VERSION, generatedAt: NOW, repos: [intel], knownUnknowns: [] };
}

function genSpecs(ws: WorkspaceIntel, proj: TargetProject, types: ToolType[]): GeneratedToolsIndex {
  const dash = buildDashboard({ generatedAt: NOW, project: proj, ws });
  const report = detectToolOpportunities({ generatedAt: NOW, scanVersion: SCAN_VERSION, dashboard: dash, ws });
  const tools: GeneratedToolSpec[] = [];
  for (const t of types) {
    const p = report.proposals.find((x) => x.type === t);
    if (p) { const s = generateTool({ generatedAt: NOW, scanVersion: SCAN_VERSION, ws, proposal: p, freshness: "fresh", scanBaseCommit: "abc" }); if (s) tools.push(s); }
  }
  return { version: 1, targetProjectId: proj.id, generatedAt: NOW, tools };
}

const liveHash = (repoRoot: string, rel: string) => hashFile(join(repoRoot, rel));
const noGit = () => ({ commit: null, dirty: null });

function makeRepo(): { root: string; ws: WorkspaceIntel } {
  const root = mkdtempSync(join(tmpdir(), "tf-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "api", scripts: { test: "vitest run", build: "tsc", lint: "eslint .", dev: "next dev" } }));
  writeFileSync(join(root, ".env.example"), "DATABASE_URL=\nJWT_SECRET=\n");
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "server.ts"), 'app.get("/api/a",h);app.get("/api/b",h);app.get("/api/c",h);\n');
  return { root, ws: scan(root) };
}

describe("generated-tool dependency metadata", () => {
  let root: string; let ws: WorkspaceIntel;
  beforeEach(() => ({ root, ws } = makeRepo()));
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("specs record artifact deps, source file hashes, proposal signature, generator version", () => {
    const idx = genSpecs(ws, project("api", root), ["route-explorer", "command-dashboard"]);
    const route = idx.tools.find((t) => t.type === "route-explorer")!;
    expect(route.dependsOnArtifacts).toContain("repo-map");
    expect(route.sourceFileHashes.length).toBeGreaterThan(0);
    expect(route.proposalSignature).toMatch(/^sig_/);
    expect(route.generatorVersion).toBeTruthy();
    const cmd = idx.tools.find((t) => t.type === "command-dashboard")!;
    expect(cmd.dependsOnArtifacts).toContain("command-book");
  });
});

describe("checkToolsFreshness — fresh / stale / needs-rescan", () => {
  let root: string; let ws: WorkspaceIntel; let proj: TargetProject;
  beforeEach(() => { ({ root, ws } = makeRepo()); proj = project("api", root); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("all tools fresh when nothing changed", () => {
    const idx = genSpecs(ws, proj, ["route-explorer", "env-var-explorer"]);
    const r = checkToolsFreshness({ generatedAt: NOW, project: proj, ws, index: idx, currentHash: liveHash, currentGit: noGit });
    expect(r.tools.every((t) => t.verdict === "fresh")).toBe(true);
    expect(r.rescanRecommended).toBe(false);
  });

  it("marks the route explorer needs-rescan when its source file changes on disk", () => {
    const idx = genSpecs(ws, proj, ["route-explorer", "env-var-explorer"]);
    // change the route file AFTER generation (the stored index still has old hash)
    writeFileSync(join(root, "src", "server.ts"), 'app.get("/api/a",h);app.get("/api/NEW",h);\n');
    const r = checkToolsFreshness({ generatedAt: NOW, project: proj, ws, index: idx, currentHash: liveHash, currentGit: noGit });
    const route = r.tools.find((t) => t.type === "route-explorer")!;
    expect(route.verdict).toBe("needs-rescan");
    expect(route.needsRescan).toBe(true);
    expect(route.changedFiles.some((f) => f.ref.includes("server.ts"))).toBe(true);
    // the env explorer (different source) stays fresh
    expect(r.tools.find((t) => t.type === "env-var-explorer")!.verdict).toBe("fresh");
  });

  it("marks a tool stale when its generator version is older", () => {
    const idx = genSpecs(ws, proj, ["route-explorer"]);
    idx.tools[0].generatorVersion = "0.0.1-old";
    const r = checkToolsFreshness({ generatedAt: NOW, project: proj, ws, index: idx, currentHash: liveHash, currentGit: noGit });
    const t = r.tools[0];
    expect(t.verdict).toBe("stale");
    expect(t.canAutoUpdate).toBe(true); // index is fresh → can regenerate without re-scan
    expect(t.reasons.some((x) => /generator/i.test(x))).toBe(true);
  });

  it("marks a tool stale when the proposal signature changed materially", () => {
    const idx = genSpecs(ws, proj, ["route-explorer"]);
    idx.tools[0].proposalSignature = "sig_stale";
    const r = checkToolsFreshness({ generatedAt: NOW, project: proj, ws, index: idx, currentHash: liveHash, currentGit: noGit });
    expect(r.tools[0].verdict).toBe("stale");
    expect(r.tools[0].reasons.some((x) => /proposal changed/i.test(x))).toBe(true);
  });
});

describe("regenerateTools — host-side update + report", () => {
  let root: string; let ws: WorkspaceIntel; let proj: TargetProject;
  beforeEach(() => { ({ root, ws } = makeRepo()); proj = project("api", root); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("auto-updates a generator-stale tool from the current (fresh) index", () => {
    const idx = genSpecs(ws, proj, ["route-explorer"]);
    idx.tools[0].generatorVersion = "0.0.1-old";
    const fresh = checkToolsFreshness({ generatedAt: NOW + 1, project: proj, ws, index: idx, currentHash: liveHash, currentGit: noGit });
    const { index, report } = regenerateTools({ generatedAt: NOW + 1, project: proj, ws, index: idx, freshnessReport: fresh });
    expect(report.outcomes[0].status).toBe("updated");
    expect(index.tools[0].generatorVersion).not.toBe("0.0.1-old");
    expect(report.summary).toMatch(/not modified/i);
  });

  it("does NOT pretend to update when a re-scan is needed (source changed, index behind)", () => {
    const idx = genSpecs(ws, proj, ["route-explorer"]);
    writeFileSync(join(root, "src", "server.ts"), 'app.get("/api/x",h);\n'); // changed on disk
    const fresh = checkToolsFreshness({ generatedAt: NOW + 1, project: proj, ws, index: idx, currentHash: liveHash, currentGit: noGit });
    const { report } = regenerateTools({ generatedAt: NOW + 1, project: proj, ws, index: idx, freshnessReport: fresh, only: "route-explorer" });
    expect(report.outcomes[0].status).toBe("stale-needs-rescan");
    expect(report.stillStale).toContain(idx.tools[0].id);
    expect(report.outcomes[0].reasons.some((r) => /re-scan/i.test(r))).toBe(true);
  });

  it("after a re-scan picks up the change, regeneration succeeds", () => {
    const idx = genSpecs(ws, proj, ["route-explorer"]);
    writeFileSync(join(root, "src", "server.ts"), 'app.get("/api/x",h);app.get("/api/y",h);\n');
    const ws2 = scan(root); // RE-SCAN — now the index matches the disk
    const fresh = checkToolsFreshness({ generatedAt: NOW + 2, project: proj, ws: ws2, index: idx, currentHash: liveHash, currentGit: noGit });
    // freshness now compares the NEW index to disk → fresh files → not needs-rescan
    const { index, report } = regenerateTools({ generatedAt: NOW + 2, project: proj, ws: ws2, index: idx, freshnessReport: fresh, only: "route-explorer" });
    expect(["updated", "unchanged"]).toContain(report.outcomes[0].status);
    const routes = index.tools[0].sections.find((s) => s.id === "routes")!;
    expect(routes.rows!.some((r) => r[2] === "/api/y")).toBe(true); // reflects the new route
  });
});
