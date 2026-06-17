import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scanRepo } from "../intel/scanner.js";
import { hashContent, SCAN_VERSION } from "../intel/grounding.js";
import {
  affectedArtifactsFor,
  categorizeFile,
  computeFreshness,
} from "../intel/freshness.js";
import type { WorkspaceIntel } from "../intel/types.js";

const NOW = 1_700_000_000_000;

describe("categorizeFile", () => {
  it("classifies the important file kinds (req #4)", () => {
    expect(categorizeFile("package.json")).toBe("manifest");
    expect(categorizeFile("pnpm-lock.yaml")).toBe("lockfile");
    expect(categorizeFile("uv.lock")).toBe("lockfile");
    expect(categorizeFile("src/app.ts")).toBe("source");
    expect(categorizeFile("Dockerfile")).toBe("docker-deploy");
    expect(categorizeFile("cicd/pipeline.yaml")).toBe("docker-deploy");
    expect(categorizeFile(".env.example")).toBe("env-example");
    expect(categorizeFile("README.md")).toBe("readme-docs");
    expect(categorizeFile("docs/guide.md")).toBe("readme-docs");
    expect(categorizeFile("Makefile")).toBe("script");
    expect(categorizeFile("scripts/run.sh")).toBe("script");
    expect(categorizeFile("tsconfig.json")).toBe("config");
  });
});

describe("affectedArtifactsFor (req #5)", () => {
  it("maps categories to invalidated artifacts", () => {
    expect(affectedArtifactsFor(["manifest"])).toContain("command-book");
    expect(affectedArtifactsFor(["docker-deploy"])).toContain("deployment-explanation");
    expect(affectedArtifactsFor(["readme-docs"])).toContain("onboarding-docs");
    expect(affectedArtifactsFor(["route"])).toContain("known-flows");
    expect(affectedArtifactsFor(["source"])).toContain("confidence-report");
  });
});

describe("computeFreshness verdicts (req #3)", () => {
  let root: string;
  let ws: WorkspaceIntel;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "fr-tgt-"));
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "p", scripts: { test: "vitest run" } }));
    // include a route so the file is CITED by a finding (freshness only tracks
    // files that produced findings — see test below + report limitations).
    writeFileSync(join(root, "src", "a.ts"), 'export function f(){ app.get("/a", () => {}); return g(); }\n');
    const intel = scanRepo(root, { generatedAt: NOW });
    // pretend it was a git scan at commit "aaa", clean
    intel.isGitRepo = true;
    intel.gitCommit = "aaa";
    intel.gitDirty = false;
    ws = { rootPath: root, targetPath: root, scanVersion: SCAN_VERSION, generatedAt: NOW, repos: [intel], knownUnknowns: [] };
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const realHash = (repoRoot: string, rel: string) => {
    try {
      return hashContent(readFileSync(join(repoRoot, rel), "utf-8"));
    } catch {
      return null;
    }
  };

  it("FRESH when nothing changed and commit matches", () => {
    const r = computeFreshness(ws, realHash, () => ({ commit: "aaa", dirty: false }));
    expect(r.overall).toBe("fresh");
    expect(r.repos[0].affectedArtifacts).toEqual([]);
  });

  it("STALE when an indexed file's content changed", () => {
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "p", scripts: { test: "vitest run --coverage" } }));
    const r = computeFreshness(ws, realHash, () => ({ commit: "aaa", dirty: true }));
    expect(r.overall).toBe("stale");
    expect(r.repos[0].driftedCategories).toContain("manifest");
    expect(r.repos[0].affectedArtifacts).toContain("command-book");
  });

  it("POSSIBLY-STALE when commit moved but no indexed file changed", () => {
    const r = computeFreshness(ws, realHash, () => ({ commit: "bbb", dirty: false }));
    expect(r.overall).toBe("possibly-stale");
    expect(r.repos[0].reasons.join(" ")).toMatch(/commit moved/);
  });

  it("POSSIBLY-STALE when working tree is dirty (no indexed file changed)", () => {
    const r = computeFreshness(ws, realHash, () => ({ commit: "aaa", dirty: true }));
    expect(r.overall).toBe("possibly-stale");
  });

  it("UNKNOWN when current git state can't be read", () => {
    const r = computeFreshness(ws, realHash, () => ({ commit: null, dirty: null }));
    expect(r.overall).toBe("unknown");
  });

  it("refines a changed route file into the 'route' category", () => {
    // src/a.ts is cited (it declares a route), so changing it is detected and
    // refined from 'source' to 'route'.
    writeFileSync(join(root, "src", "a.ts"), 'export function f(){ app.get("/a", () => {}); return h(); }\n');
    const r = computeFreshness(ws, realHash, () => ({ commit: "aaa", dirty: true }));
    expect(r.repos[0].driftedCategories).toContain("route");
  });
});
