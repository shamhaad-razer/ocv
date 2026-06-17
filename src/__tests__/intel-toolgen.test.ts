import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scanRepo } from "../intel/scanner.js";
import { buildDashboard } from "../intel/dashboard.js";
import { buildFlowMap } from "../intel/flowmap.js";
import { listRepoFiles } from "../intel/explain.js";
import { detectToolOpportunities } from "../intel/tooldetect.js";
import { generateTool, isGeneratable } from "../intel/toolgen.js";
import { SCAN_VERSION } from "../intel/grounding.js";
import type { TargetProject } from "../intel/registry.js";
import type { ToolType, WorkspaceIntel, GeneratedToolSpec } from "../intel/types.js";

const NOW = 1_700_000_000_000;

function project(id: string, targetPath: string, repoType: TargetProject["repoType"], repos: string[]): TargetProject {
  return { id, displayName: id, targetPath, repoType, repos, createdAt: NOW, lastScannedAt: NOW, lastCommits: [], storageDir: `/host/${id}`, knownUnknownsSummary: null, freshness: { overall: "fresh", checkedAt: NOW } };
}

/** Generate the spec for a given tool type from a scanned ws (via the detector). */
function gen(type: ToolType, proj: TargetProject, ws: WorkspaceIntel, freshness: "fresh" | "potentially-stale" = "fresh"): GeneratedToolSpec | null {
  const dashboard = buildDashboard({ generatedAt: NOW, project: proj, ws });
  const report = detectToolOpportunities({ generatedAt: NOW, scanVersion: SCAN_VERSION, dashboard, ws });
  const p = report.proposals.find((x) => x.type === type);
  if (!p) return null;
  return generateTool({ generatedAt: NOW, scanVersion: SCAN_VERSION, ws, proposal: p, freshness, scanBaseCommit: "abc1234" });
}

function makeRichRepo(): { root: string; ws: WorkspaceIntel } {
  const root = mkdtempSync(join(tmpdir(), "tg-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "api", scripts: { test: "vitest run", lint: "eslint .", build: "tsc", deploy: "kubectl apply -f k8s" } }));
  writeFileSync(join(root, "Dockerfile"), "FROM node:20\nEXPOSE 3000\n");
  writeFileSync(join(root, ".env.example"), "DATABASE_URL=\nJWT_SECRET=\nAPI_KEY=\n");
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "server.ts"), ['app.get("/api/orders", h);', 'app.post("/api/orders", h);', 'app.get("/api/users", h);', 'app.get("/api/health", h);', 'app.put("/api/cart", h);'].join("\n") + "\n");
  const intel = scanRepo(root, { generatedAt: NOW });
  const ws: WorkspaceIntel = { rootPath: root, targetPath: root, scanVersion: SCAN_VERSION, generatedAt: NOW, repos: [intel], knownUnknowns: [] };
  return { root, ws };
}

describe("generateTool — supported MVP types from a rich single repo", () => {
  let root: string; let ws: WorkspaceIntel; let proj: TargetProject;
  beforeEach(() => { ({ root, ws } = makeRichRepo()); proj = project("api", root, "single-repo", ["api"]); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("generates a command dashboard with a commands table + safety-gated run actions", () => {
    const t = gen("command-dashboard", proj, ws)!;
    expect(t.type).toBe("command-dashboard");
    expect(t.id).toBe("gtool:command-dashboard:api");
    const cmds = t.sections.find((s) => s.id === "commands")!;
    expect(cmds.kind).toBe("table");
    expect(cmds.rows!.length).toBeGreaterThan(0);
    // actions are present, classified, and confirm-gated; NO deploy/install offered
    expect(t.actions.length).toBeGreaterThan(0);
    expect(t.actions.every((a) => a.safety === "confirm-required" || a.safety === "safe-auto")).toBe(true);
    expect(t.actions.some((a) => /kubectl|install/.test(a.command))).toBe(false);
    expect(t.requiresConfirmation).toBe(true);
  });

  it("generates a route/API explorer with resolved routes + source locators (read-only)", () => {
    const t = gen("api-explorer", proj, ws)!;
    const routes = t.sections.find((s) => s.id === "routes")!;
    expect(routes.columns).toContain("path");
    expect(routes.rows!.length).toBe(5);
    expect(routes.rows!.every((r) => r[3].includes(":"))).toBe(true); // file:line locator
    expect(t.actions.length).toBe(0); // read-only
    expect(t.safety).toBe("safe-auto");
  });

  it("generates an env var explorer with NAMES only (S6)", () => {
    const t = gen("env-var-explorer", proj, ws)!;
    const env = t.sections.find((s) => s.id === "env-vars")!;
    expect(env.rows!.map((r) => r[1])).toEqual(expect.arrayContaining(["DATABASE_URL", "JWT_SECRET", "API_KEY"]));
    expect(env.caption).toMatch(/names only|S6/i);
    expect(t.actions.length).toBe(0);
  });

  it("generates a deployment explorer that flags config≠live", () => {
    const t = gen("deployment-explorer", proj, ws)!;
    expect(t.sections.some((s) => s.id === "deploy-files")).toBe(true);
    expect(t.sections.some((s) => s.severity === "warn" && /production/i.test(s.text ?? ""))).toBe(true);
  });

  it("every spec carries provenance, confidence, freshness, known-unknowns, and source refs", () => {
    const t = gen("api-explorer", proj, ws)!;
    expect(t.sections[0].id).toBe("about"); // provenance first
    expect(["high", "medium", "low"]).toContain(t.confidence);
    expect(t.freshness).toBe("fresh");
    expect(t.scanVersion).toBe(SCAN_VERSION);
    expect(t.scanBaseCommit).toBe("abc1234");
    expect(t.sources.length).toBeGreaterThan(0);
    expect(t.targetPath).toBe(root);
  });

  it("warns when the source intelligence is stale", () => {
    const t = gen("api-explorer", proj, ws, "potentially-stale")!;
    expect(t.stale).toBe(true);
    expect(t.staleWarning).toMatch(/re-scan/i);
    expect(t.sections[0].id).toBe("stale-warning");
    expect(t.sections[0].severity).toBe("warn");
  });
});

describe("generateTool — multi-repo flow explorer", () => {
  it("generates a flow explorer with an edges table + a mermaid diagram", () => {
    const wsRoot = mkdtempSync(join(tmpdir(), "tg-mr-"));
    try {
      const api = join(wsRoot, "api"); mkdirSync(join(api, "src"), { recursive: true });
      writeFileSync(join(api, "package.json"), JSON.stringify({ name: "@acme/api", scripts: { build: "tsc" } }));
      writeFileSync(join(api, "src", "server.ts"), "app.listen(4000);\n");
      const web = join(wsRoot, "web"); mkdirSync(join(web, "src"), { recursive: true });
      writeFileSync(join(web, "package.json"), JSON.stringify({ name: "@acme/web", dependencies: { "@acme/api": "1.0.0" }, scripts: { build: "next build" } }));
      writeFileSync(join(web, "src", "client.ts"), 'fetch("http://localhost:4000/x");\n');
      const apiIntel = scanRepo(api, { generatedAt: NOW });
      const webIntel = scanRepo(web, { generatedAt: NOW });
      const ws: WorkspaceIntel = { rootPath: wsRoot, targetPath: wsRoot, scanVersion: SCAN_VERSION, generatedAt: NOW, repos: [apiIntel, webIntel], knownUnknowns: [] };
      ws.flowMap = buildFlowMap(ws, { generatedAt: NOW, repoFiles: { [apiIntel.name]: listRepoFiles(api), [webIntel.name]: listRepoFiles(web) } });
      const t = gen("flow-explorer", project("mr", wsRoot, "multi-repo", ["api", "web"]), ws)!;
      expect(t.sections.some((s) => s.id === "edges" && s.kind === "table")).toBe(true);
      expect(t.sections.some((s) => s.kind === "mermaid" && /flowchart/.test(s.mermaid ?? ""))).toBe(true);
    } finally {
      rmSync(wsRoot, { recursive: true, force: true });
    }
  });
});

describe("generateTool — guards", () => {
  it("isGeneratable: viewers yes, service-health no (not in MVP set)", () => {
    expect(isGeneratable("command-dashboard")).toBe(true);
    expect(isGeneratable("env-var-explorer")).toBe(true);
    expect(isGeneratable("service-health-dashboard")).toBe(false);
    expect(isGeneratable("repo-mirroring-panel")).toBe(false);
  });

  it("a known-unknowns tracker generates a table of gaps", () => {
    const { root, ws } = makeRichRepo();
    try {
      const t = gen("known-unknowns-tracker", project("api", root, "single-repo", ["api"]), ws)!;
      expect(t.sections.some((s) => s.id === "unknowns" && s.kind === "table")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
