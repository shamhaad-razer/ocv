import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scanRepo } from "../intel/scanner.js";
import { buildDeploymentReport } from "../intel/deployment.js";
import { renderDeploymentReportMarkdown } from "../intel/render.js";
import { buildFlowMap } from "../intel/flowmap.js";
import { listRepoFiles } from "../intel/explain.js";
import { SCAN_VERSION } from "../intel/grounding.js";
import type { WorkspaceIntel } from "../intel/types.js";

const NOW = 1_700_000_000_000;

/** A single repo with a Dockerfile, compose, GH Actions, Makefile, env example. */
function makeDeployRepo(): { root: string; ws: WorkspaceIntel } {
  const root = mkdtempSync(join(tmpdir(), "dep-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "shop-api", scripts: { build: "tsc", deploy: "kubectl apply -f k8s", test: "vitest run" } }));
  writeFileSync(
    join(root, "Dockerfile"),
    "FROM node:20-alpine\nWORKDIR /app\nCOPY . .\nRUN npm ci && npm run build\nEXPOSE 3000\nENV DATABASE_URL=\nCMD [\"node\", \"dist/server.js\"]\n",
  );
  writeFileSync(
    join(root, "docker-compose.yml"),
    "services:\n  api:\n    build: .\n    ports:\n      - \"3000:3000\"\n    environment:\n      - DATABASE_URL\n  db:\n    image: postgres:16\n    ports:\n      - \"5432:5432\"\n",
  );
  mkdirSync(join(root, ".github", "workflows"), { recursive: true });
  writeFileSync(
    join(root, ".github", "workflows", "deploy.yml"),
    "name: deploy\non: [push]\njobs:\n  ship:\n    steps:\n      - run: npm run build\n      - run: docker build -t shop-api .\n      - run: kubectl apply -f k8s/\n",
  );
  writeFileSync(join(root, "Makefile"), "build:\n\tdocker build -t shop-api .\ndeploy:\n\tkubectl apply -f k8s/\n");
  writeFileSync(join(root, ".env.example"), "DATABASE_URL=\nJWT_SECRET=\nELEVENLABS_API_KEY=\n");
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "server.ts"), 'app.listen(3000);\napp.get("/health", () => {});\n');

  const intel = scanRepo(root, { generatedAt: NOW });
  const ws: WorkspaceIntel = { rootPath: root, targetPath: root, scanVersion: SCAN_VERSION, generatedAt: NOW, repos: [intel], knownUnknowns: [] };
  return { root, ws };
}

describe("buildDeploymentReport — single repo", () => {
  let root: string;
  let ws: WorkspaceIntel;
  beforeEach(() => {
    ({ root, ws } = makeDeployRepo());
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("detects the major deployment signal types", () => {
    const r = buildDeploymentReport(ws, { generatedAt: NOW });
    const types = new Set(r.repos[0].signals.map((s) => s.type));
    expect(types.has("dockerfile")).toBe(true);
    expect(types.has("compose")).toBe(true);
    expect(types.has("github-actions")).toBe(true);
    expect(types.has("makefile")).toBe(true);
    expect(types.has("env-example")).toBe(true);
  });

  it("each signal is source-grounded and carries confidence + freshness", () => {
    const r = buildDeploymentReport(ws, { generatedAt: NOW });
    for (const s of r.repos[0].signals) {
      expect(s.sources.length).toBeGreaterThan(0);
      expect(["high", "medium", "low"]).toContain(s.confidence);
      expect(s.freshness).toBeTruthy();
    }
  });

  it("extracts ports, env var NAMES (never values), and commands", () => {
    const r = buildDeploymentReport(ws, { generatedAt: NOW });
    const repo = r.repos[0];
    // ports from Dockerfile EXPOSE + compose mappings
    const allPorts = new Set(repo.signals.flatMap((s) => s.ports));
    expect(allPorts.has(3000)).toBe(true);
    expect(allPorts.has(5432)).toBe(true);
    // env var names surfaced; values never read
    expect(repo.requiredEnvVars).toContain("DATABASE_URL");
    expect(repo.requiredEnvVars).toContain("JWT_SECRET");
    // commands captured (build/deploy verbs)
    expect(repo.commands.some((c) => /kubectl|docker build|tsc|build/.test(c.command))).toBe(true);
  });

  it("infers runtime dependencies (datastore from postgres image / DATABASE_URL)", () => {
    const r = buildDeploymentReport(ws, { generatedAt: NOW });
    const deps = r.repos[0].runtimeDependencies;
    expect(deps.some((d) => d.kind === "datastore")).toBe(true);
    // ELEVENLABS_API_KEY → external api (inferred, low confidence)
    expect(deps.some((d) => d.kind === "external-api")).toBe(true);
  });

  it("produces a Mermaid diagram when there is evidence", () => {
    const r = buildDeploymentReport(ws, { generatedAt: NOW });
    expect(r.diagram).toContain("flowchart");
    const md = renderDeploymentReportMarkdown(r);
    expect(md).toContain("# Deployment Report");
    expect(md).toContain("```mermaid");
    expect(md).toContain("What is unknown");
  });

  it("always flags production topology as unknown (never invents it)", () => {
    const r = buildDeploymentReport(ws, { generatedAt: NOW });
    expect(r.unknown.some((u) => /production|live/i.test(u))).toBe(true);
  });

  it("separates source-grounded from inferred", () => {
    const r = buildDeploymentReport(ws, { generatedAt: NOW });
    expect(r.sourceGrounded.length).toBeGreaterThan(0);
    expect(r.inferred.length).toBeGreaterThan(0);
  });
});

describe("buildDeploymentReport — no deployment config", () => {
  let root: string;
  let ws: WorkspaceIntel;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "dep-bare-"));
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "lib", scripts: { test: "vitest" } }));
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "index.ts"), "export const x = 1;\n");
    const intel = scanRepo(root, { generatedAt: NOW });
    ws = { rootPath: root, targetPath: root, scanVersion: SCAN_VERSION, generatedAt: NOW, repos: [intel], knownUnknowns: [] };
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("clearly says deployment is unknown and records a known-unknown", () => {
    const r = buildDeploymentReport(ws, { generatedAt: NOW });
    expect(r.unknown.some((u) => /unknown from source|no container/i.test(u))).toBe(true);
    expect(r.knownUnknowns.some((u) => u.id === "deploy:no-strong-signal")).toBe(true);
    expect(r.confidence).toBe("low");
    expect(r.diagram).toBe(""); // no evidence → no diagram
  });
});

describe("buildDeploymentReport — multi-repo coupling", () => {
  let wsRoot: string;
  let ws: WorkspaceIntel;
  beforeEach(() => {
    wsRoot = mkdtempSync(join(tmpdir(), "dep-mr-"));
    // api repo with a Dockerfile + package name
    const api = join(wsRoot, "api");
    mkdirSync(join(api, "src"), { recursive: true });
    writeFileSync(join(api, "package.json"), JSON.stringify({ name: "@acme/api", scripts: { build: "tsc" } }));
    writeFileSync(join(api, "Dockerfile"), "FROM node:20\nEXPOSE 4000\n");
    writeFileSync(join(api, ".env.example"), "DATABASE_URL=\n");
    writeFileSync(join(api, "src", "server.ts"), "app.listen(4000);\n");
    // web repo depending on @acme/api + sharing DATABASE_URL
    const web = join(wsRoot, "web");
    mkdirSync(join(web, "src"), { recursive: true });
    writeFileSync(join(web, "package.json"), JSON.stringify({ name: "@acme/web", dependencies: { "@acme/api": "1.0.0" }, scripts: { build: "next build" } }));
    writeFileSync(join(web, "Dockerfile"), "FROM node:20\nEXPOSE 3000\n");
    writeFileSync(join(web, ".env.example"), "DATABASE_URL=\n");
    writeFileSync(join(web, "src", "client.ts"), 'fetch("http://localhost:4000/orders");\n');

    const apiIntel = scanRepo(api, { generatedAt: NOW });
    const webIntel = scanRepo(web, { generatedAt: NOW });
    const repoFiles = { [apiIntel.name]: listRepoFiles(api), [webIntel.name]: listRepoFiles(web) };
    ws = { rootPath: wsRoot, targetPath: wsRoot, scanVersion: SCAN_VERSION, generatedAt: NOW, repos: [apiIntel, webIntel], knownUnknowns: [] };
    ws.flowMap = buildFlowMap(ws, { generatedAt: NOW, repoFiles });
  });
  afterEach(() => rmSync(wsRoot, { recursive: true, force: true }));

  it("shows cross-repo deploy coupling without inventing topology", () => {
    const r = buildDeploymentReport(ws, { generatedAt: NOW });
    expect(r.multiRepo).toBe(true);
    expect(r.crossRepoLinks.length).toBeGreaterThan(0);
    // the shared-package dep → co-deployed coupling
    expect(r.crossRepoLinks.some((l) => l.kind === "co-deployed" || l.kind === "runtime-coupled" || l.kind === "shared-config")).toBe(true);
    // still honest about prod
    expect(r.unknown.some((u) => /production|live/i.test(u))).toBe(true);
    const md = renderDeploymentReportMarkdown(r);
    expect(md).toContain("Cross-repo deployment coupling");
  });
});
