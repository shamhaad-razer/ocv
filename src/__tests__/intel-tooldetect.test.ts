import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scanRepo } from "../intel/scanner.js";
import { buildDashboard } from "../intel/dashboard.js";
import { buildFlowMap } from "../intel/flowmap.js";
import { listRepoFiles } from "../intel/explain.js";
import { detectToolOpportunities } from "../intel/tooldetect.js";
import { SCAN_VERSION } from "../intel/grounding.js";
import type { TargetProject } from "../intel/registry.js";
import type { ToolType, WorkspaceIntel } from "../intel/types.js";

const NOW = 1_700_000_000_000;

function project(id: string, targetPath: string, repoType: TargetProject["repoType"], repos: string[]): TargetProject {
  return {
    id, displayName: id, targetPath, repoType, repos,
    createdAt: NOW, lastScannedAt: NOW, lastCommits: [],
    storageDir: `/host/.openclaw-intel/${id}`,
    knownUnknownsSummary: null, freshness: { overall: "fresh", checkedAt: NOW },
  };
}

function detect(proj: TargetProject, ws: WorkspaceIntel | null) {
  const dashboard = buildDashboard({ generatedAt: NOW, project: proj, ws });
  return detectToolOpportunities({ generatedAt: NOW, scanVersion: SCAN_VERSION, dashboard, ws });
}

function types(r: { proposals: { type: ToolType }[] }): ToolType[] {
  return r.proposals.map((p) => p.type);
}

describe("detectToolOpportunities — route-heavy single repo", () => {
  let root: string;
  let ws: WorkspaceIntel;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "td-api-"));
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "api", scripts: { test: "vitest run", lint: "eslint .", build: "tsc", dev: "next dev" } }));
    writeFileSync(join(root, "Dockerfile"), "FROM node:20\nEXPOSE 3000\n");
    writeFileSync(join(root, ".env.example"), "DATABASE_URL=\nJWT_SECRET=\nAPI_KEY=\n");
    mkdirSync(join(root, "src"));
    writeFileSync(
      join(root, "src", "server.ts"),
      ['app.get("/api/orders", h);', 'app.post("/api/orders", h);', 'app.get("/api/users", h);', 'app.delete("/api/users/:id", h);', 'app.get("/api/health", h);', 'app.put("/api/cart", h);'].join("\n") + "\n",
    );
    const intel = scanRepo(root, { generatedAt: NOW });
    ws = { rootPath: root, targetPath: root, scanVersion: SCAN_VERSION, generatedAt: NOW, repos: [intel], knownUnknowns: [] };
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("proposes an API explorer when there are many routes", () => {
    const r = detect(project("api", root, "single-repo", ["api"]), ws);
    expect(types(r)).toContain("api-explorer");
    const api = r.proposals.find((p) => p.type === "api-explorer")!;
    expect(api.whyUseful.length).toBeGreaterThan(0);
    expect(api.userProblem.length).toBeGreaterThan(0);
    expect(api.evidence.length).toBeGreaterThan(0);
    expect(api.interactivity).toBe("interactive");
  });

  it("proposes a command dashboard + deployment explorer + env explorer (project-specific)", () => {
    const ts = types(detect(project("api", root, "single-repo", ["api"]), ws));
    expect(ts).toContain("command-dashboard");
    expect(ts).toContain("deployment-explorer");
    expect(ts).toContain("env-var-explorer");
    expect(ts).toContain("test-runner-guide");
  });

  it("command dashboard / test runner are confirm-required + runtime-assisted (safety)", () => {
    const r = detect(project("api", root, "single-repo", ["api"]), ws);
    const cmd = r.proposals.find((p) => p.type === "command-dashboard")!;
    expect(cmd.safety).toBe("confirm-required");
    expect(cmd.requiresConfirmation).toBe(true);
    expect(cmd.requiresRuntimeChecks).toBe(true);
    expect(cmd.interactivity).toBe("runtime-assisted");
  });

  it("every proposal carries confidence, freshness, and known-unknowns; never overclaims", () => {
    const r = detect(project("api", root, "single-repo", ["api"]), ws);
    for (const p of r.proposals) {
      expect(["high", "medium", "low"]).toContain(p.confidence);
      expect(p.freshness).toBeTruthy();
      expect(p.id).toMatch(/^tool:/);
      expect(p.targetProjectId).toBe("api");
    }
    // always includes a known-unknowns tracker
    expect(types(r)).toContain("known-unknowns-tracker");
  });
});

describe("detectToolOpportunities — multi-repo with inferred edges", () => {
  it("proposes a flow explorer + repo mirroring panel", () => {
    const wsRoot = mkdtempSync(join(tmpdir(), "td-mr-"));
    try {
      const api = join(wsRoot, "api");
      mkdirSync(join(api, "src"), { recursive: true });
      writeFileSync(join(api, "package.json"), JSON.stringify({ name: "@acme/api", scripts: { build: "tsc" } }));
      writeFileSync(join(api, ".env.example"), "DATABASE_URL=\n");
      writeFileSync(join(api, "src", "server.ts"), "app.listen(4000);\n");
      const web = join(wsRoot, "web");
      mkdirSync(join(web, "src"), { recursive: true });
      writeFileSync(join(web, "package.json"), JSON.stringify({ name: "@acme/web", dependencies: { "@acme/api": "1.0.0" }, scripts: { build: "next build" } }));
      writeFileSync(join(web, ".env.example"), "DATABASE_URL=\n");
      writeFileSync(join(web, "src", "client.ts"), 'fetch("http://localhost:4000/x");\n');

      const apiIntel = scanRepo(api, { generatedAt: NOW });
      const webIntel = scanRepo(web, { generatedAt: NOW });
      const ws: WorkspaceIntel = { rootPath: wsRoot, targetPath: wsRoot, scanVersion: SCAN_VERSION, generatedAt: NOW, repos: [apiIntel, webIntel], knownUnknowns: [] };
      ws.flowMap = buildFlowMap(ws, { generatedAt: NOW, repoFiles: { [apiIntel.name]: listRepoFiles(api), [webIntel.name]: listRepoFiles(web) } });

      const r = detect(project("mr", wsRoot, "multi-repo", ["api", "web"]), ws);
      expect(types(r)).toContain("flow-explorer");
      expect(types(r)).toContain("repo-mirroring-panel");
      const flow = r.proposals.find((p) => p.type === "flow-explorer")!;
      expect(flow.knownUnknowns.some((u) => /inferred/i.test(u.title))).toBe(true);
    } finally {
      rmSync(wsRoot, { recursive: true, force: true });
    }
  });
});

describe("detectToolOpportunities — thin / not-scanned → known-unknowns fallback", () => {
  it("a not-scanned target proposes ONLY a known-unknowns tracker (no overclaim)", () => {
    const r = detect(project("ghost", "/tmp/ghost", "unknown", []), null);
    expect(r.scanned).toBe(false);
    expect(types(r)).toEqual(["known-unknowns-tracker"]);
    expect(r.summary).toMatch(/not been scanned/i);
    expect(r.knownUnknowns.some((u) => u.id === "tooldetect:not-scanned")).toBe(true);
  });

  it("a bare scanned repo (no routes/deploy/env) leans on the known-unknowns tracker", () => {
    const root = mkdtempSync(join(tmpdir(), "td-bare-"));
    try {
      writeFileSync(join(root, "package.json"), JSON.stringify({ name: "lib" }));
      mkdirSync(join(root, "src"));
      writeFileSync(join(root, "src", "index.ts"), "export const x = 1;\n");
      const intel = scanRepo(root, { generatedAt: NOW });
      const ws: WorkspaceIntel = { rootPath: root, targetPath: root, scanVersion: SCAN_VERSION, generatedAt: NOW, repos: [intel], knownUnknowns: [] };
      const r = detect(project("lib", root, "single-repo", ["lib"]), ws);
      expect(types(r)).toContain("known-unknowns-tracker");
      // no API explorer for a repo with no routes
      expect(types(r)).not.toContain("api-explorer");
      expect(types(r)).not.toContain("deployment-explorer");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("detectToolOpportunities — report shape", () => {
  it("ranks proposals by score and reports overall confidence + an honest summary", () => {
    const root = mkdtempSync(join(tmpdir(), "td-shape-"));
    try {
      writeFileSync(join(root, "package.json"), JSON.stringify({ name: "api", scripts: { test: "vitest", build: "tsc" } }));
      mkdirSync(join(root, "src"));
      writeFileSync(join(root, "src", "s.ts"), 'app.get("/a", h);\napp.get("/b", h);\n');
      const intel = scanRepo(root, { generatedAt: NOW });
      const ws: WorkspaceIntel = { rootPath: root, targetPath: root, scanVersion: SCAN_VERSION, generatedAt: NOW, repos: [intel], knownUnknowns: [] };
      const r = detect(project("api", root, "single-repo", ["api"]), ws);
      for (let i = 1; i < r.proposals.length; i++) expect(r.proposals[i - 1].score).toBeGreaterThanOrEqual(r.proposals[i].score);
      expect(r.knownUnknowns.some((u) => u.id === "tooldetect:proposals-not-generated")).toBe(true);
      expect(r.summary).toMatch(/grounded suggestions|EXISTING intelligence|nothing is generated/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
