import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scanRepo } from "../intel/scanner.js";
import { buildDashboard } from "../intel/dashboard.js";
import { SCAN_VERSION } from "../intel/grounding.js";
import type { TargetProject } from "../intel/registry.js";
import type { WorkspaceIntel } from "../intel/types.js";

const NOW = 1_700_000_000_000;

function makeProject(targetPath: string, overrides: Partial<TargetProject> = {}): TargetProject {
  return {
    id: "abc123",
    displayName: "shop-api",
    targetPath,
    repoType: "single-repo",
    repos: ["shop-api"],
    createdAt: NOW,
    lastScannedAt: NOW,
    lastCommits: [],
    storageDir: "/host/.openclaw-intel/shop-api-abc123",
    knownUnknownsSummary: { total: 0, byImpact: { high: 0, medium: 0, low: 0 } },
    freshness: { overall: "fresh", checkedAt: NOW },
    ...overrides,
  };
}

function makeWs(): { root: string; ws: WorkspaceIntel } {
  const root = mkdtempSync(join(tmpdir(), "dash-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "shop-api", scripts: { test: "vitest run", build: "tsc", deploy: "kubectl apply -f k8s" } }));
  writeFileSync(join(root, "Dockerfile"), "FROM node:20\nEXPOSE 3000\n");
  writeFileSync(join(root, ".env.example"), "DATABASE_URL=\n");
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "server.ts"), 'app.get("/api/x", () => {});\n');
  const intel = scanRepo(root, { generatedAt: NOW });
  const ws: WorkspaceIntel = { rootPath: root, targetPath: root, scanVersion: SCAN_VERSION, generatedAt: NOW, repos: [intel], knownUnknowns: [] };
  return { root, ws };
}

describe("buildDashboard", () => {
  let root: string;
  let ws: WorkspaceIntel;
  beforeEach(() => {
    ({ root, ws } = makeWs());
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("aggregates project metadata, repo map, commands, and freshness/confidence/unknowns", () => {
    const d = buildDashboard({ generatedAt: NOW, project: makeProject(root), ws });
    expect(d.scanned).toBe(true);
    expect(d.project.displayName).toBe("shop-api");
    expect(d.repos.length).toBe(1);
    expect(d.repos[0].scripts).toBeGreaterThan(0);
    expect(d.commands.total).toBeGreaterThan(0);
    expect(["high", "medium", "low"]).toContain(d.confidence.overall);
    expect(d.freshness).toBe("fresh");
    // known-unknowns are surfaced (scan records at least the shallow-graph + unvalidated-command)
    expect(d.knownUnknowns.total).toBeGreaterThan(0);
    expect(d.knownUnknowns.top.length).toBeGreaterThan(0);
  });

  it("peeks at deployment signals without running the full explorer", () => {
    const d = buildDashboard({ generatedAt: NOW, project: makeProject(root), ws });
    expect(d.deployment.hasSignals).toBe(true);
    expect(d.deployment.signalFiles.some((f) => /Dockerfile/.test(f))).toBe(true);
  });

  it("folds in the local environment status when provided", () => {
    const d = buildDashboard({
      generatedAt: NOW,
      project: makeProject(root),
      ws,
      environment: { available: true, osVariant: "wsl", shell: "/bin/zsh", toolsPresent: ["node", "git"], toolsMissing: ["pnpm"] },
    });
    expect(d.environment?.available).toBe(true);
    expect(d.environment?.osVariant).toBe("wsl");
    expect(d.environment?.toolsMissing).toContain("pnpm");
  });

  it("degrades honestly when the target has not been scanned", () => {
    const d = buildDashboard({ generatedAt: NOW, project: makeProject(root, { lastScannedAt: null, freshness: undefined }), ws: null });
    expect(d.scanned).toBe(false);
    expect(d.freshness).toBe("unknown");
    expect(d.repos).toEqual([]);
    expect(d.commands.total).toBe(0);
    expect(d.summary).toMatch(/not been scanned/i);
    // still states the host-vs-target / read-only stance
    expect(d.summary).toMatch(/never modifies|only reads|reads this target/i);
  });

  it("summary states this is an external target OpenClaw only reads", () => {
    const d = buildDashboard({ generatedAt: NOW, project: makeProject(root), ws });
    expect(d.summary).toMatch(/EXTERNAL target|only reads/i);
  });
});
