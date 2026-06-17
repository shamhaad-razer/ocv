import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scanRepo } from "../intel/scanner.js";
import { buildFlowMap, flowForRepo } from "../intel/flowmap.js";
import { renderFlowMapMarkdown } from "../intel/render.js";
import { listRepoFiles } from "../intel/explain.js";
import { SCAN_VERSION } from "../intel/grounding.js";
import type { WorkspaceIntel } from "../intel/types.js";

const NOW = 1_700_000_000_000;

/** Build a multi-repo target workspace: api (service :4000) + web (depends on api pkg, calls localhost:4000). */
function makeWorkspace(): { root: string; ws: WorkspaceIntel; repoFiles: Record<string, string[]> } {
  const root = mkdtempSync(join(tmpdir(), "ws-"));
  // api repo
  const api = join(root, "api");
  mkdirSync(join(api, "src"), { recursive: true });
  writeFileSync(join(api, "package.json"), JSON.stringify({ name: "@acme/api", scripts: { dev: "node server.js" } }));
  writeFileSync(join(api, "next.config.ts"), "export default {};\n"); // gives it a service w/ port 3000... use server entry instead
  rmSync(join(api, "next.config.ts"));
  writeFileSync(join(api, "src", "server.ts"), 'app.listen(4000);\napp.get("/orders", () => {});\n');
  writeFileSync(join(api, ".env.example"), "DATABASE_URL=\nJWT_SECRET=\n");
  // web repo: depends on @acme/api, references localhost:4000, shares DATABASE_URL
  const web = join(root, "web");
  mkdirSync(join(web, "src"), { recursive: true });
  writeFileSync(join(web, "package.json"), JSON.stringify({ name: "@acme/web", dependencies: { "@acme/api": "1.0.0" }, scripts: { dev: "next dev" } }));
  writeFileSync(join(web, "src", "client.ts"), 'const API = "http://localhost:4000";\nfetch(API + "/orders");\n');
  writeFileSync(join(web, ".env.example"), "DATABASE_URL=\nNEXT_PUBLIC_API=\n");

  const apiIntel = scanRepo(api, { generatedAt: NOW });
  const webIntel = scanRepo(web, { generatedAt: NOW });
  // give api a service on :4000 so the port-edge can match
  apiIntel.services.push({
    value: { name: "api-server", kind: "http", evidence: "src/server.ts", defaultPort: 4000 },
    grounding: apiIntel.grounding,
  });
  const ws: WorkspaceIntel = {
    rootPath: root, targetPath: root, scanVersion: SCAN_VERSION, generatedAt: NOW,
    repos: [apiIntel, webIntel], knownUnknowns: [],
  };
  const repoFiles = { [apiIntel.name]: listRepoFiles(api), [webIntel.name]: listRepoFiles(web) };
  return { root, ws, repoFiles };
}

describe("buildFlowMap", () => {
  let root: string;
  let ws: WorkspaceIntel;
  let repoFiles: Record<string, string[]>;
  beforeEach(() => {
    ({ root, ws, repoFiles } = makeWorkspace());
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("detects a shared-package edge (high confidence) web → api", () => {
    const flow = buildFlowMap(ws, { generatedAt: NOW, repoFiles });
    const dep = flow.edges.find((e) => e.kind === "shared-package");
    expect(dep).toBeTruthy();
    expect(dep?.from).toBe("web");
    expect(dep?.to).toBe("api");
    expect(dep?.confidence).toBe("high"); // declared dependency = proven
  });

  it("detects a localhost-port edge (medium) when web references the api's port", () => {
    const flow = buildFlowMap(ws, { generatedAt: NOW, repoFiles });
    const port = flow.edges.find((e) => e.kind === "localhost-port");
    expect(port?.from).toBe("web");
    expect(port?.to).toBe("api");
    expect(port?.confidence).toBe("medium");
    expect(port?.evidence[0]?.locator).toMatch(/client\.ts/);
  });

  it("detects a shared-env-var edge (low) for DATABASE_URL but ignores ubiquitous vars", () => {
    const flow = buildFlowMap(ws, { generatedAt: NOW, repoFiles });
    const env = flow.edges.find((e) => e.kind === "shared-env-var");
    expect(env?.confidence).toBe("low");
    expect(env?.label).toMatch(/DATABASE_URL/);
  });

  it("records the inferred-edges known-unknown (never claims a proven graph)", () => {
    const flow = buildFlowMap(ws, { generatedAt: NOW, repoFiles });
    expect(flow.knownUnknowns.some((u) => u.id === "flowmap:no-call-graph")).toBe(true);
  });

  it("renders a Mermaid diagram + nodes + edges", () => {
    const md = renderFlowMapMarkdown(buildFlowMap(ws, { generatedAt: NOW, repoFiles }));
    expect(md).toContain("# Multi-Repo Flow Map (generated)");
    expect(md).toContain("```mermaid");
    expect(md).toContain("flowchart LR");
    expect(md).toMatch(/INFERRED/);
  });

  it("flowForRepo returns edges touching a repo", () => {
    const flow = buildFlowMap(ws, { generatedAt: NOW, repoFiles });
    const f = flowForRepo(flow, "api");
    expect(f.edges.length).toBeGreaterThan(0);
    expect(f.edges.every((e) => e.from === "api" || e.to === "api")).toBe(true);
  });

  it("single-repo workspace records the single-repo known-unknown and no edges", () => {
    const single = mkdtempSync(join(tmpdir(), "single-"));
    try {
      mkdirSync(join(single, "r"));
      writeFileSync(join(single, "r", "package.json"), JSON.stringify({ name: "solo" }));
      const intel = scanRepo(join(single, "r"), { generatedAt: NOW });
      const sws: WorkspaceIntel = { rootPath: single, targetPath: single, scanVersion: SCAN_VERSION, generatedAt: NOW, repos: [intel], knownUnknowns: [] };
      const flow = buildFlowMap(sws, { generatedAt: NOW, repoFiles: { [intel.name]: [] } });
      expect(flow.edges).toHaveLength(0);
      expect(flow.knownUnknowns.some((u) => u.id === "flowmap:single-repo")).toBe(true);
    } finally {
      rmSync(single, { recursive: true, force: true });
    }
  });
});
