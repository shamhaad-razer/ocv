import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scanRepo } from "../intel/scanner.js";
import { buildChangeReport } from "../intel/change.js";
import { renderChangeReportMarkdown } from "../intel/render.js";
import { SCAN_VERSION } from "../intel/grounding.js";
import type { WorkspaceIntel } from "../intel/types.js";

const FIXED_NOW = 1_700_000_000_000;

function git(root: string, args: string[]) {
  execFileSync("git", ["-C", root, ...args], { stdio: ["ignore", "ignore", "ignore"] });
}

/** A real git repo with a committed baseline, so working-tree changes are detectable. */
function makeGitRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "intel-chg-"));
  git(root, ["init"]);
  git(root, ["config", "user.email", "t@t.t"]);
  git(root, ["config", "user.name", "t"]);
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "svc", scripts: { test: "vitest run", lint: "eslint .", build: "tsc" } }));
  writeFileSync(join(root, "Dockerfile"), "FROM node:20\n");
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "server.ts"), 'app.get("/api/x", () => {});\n');
  git(root, ["add", "-A"]);
  git(root, ["commit", "-m", "baseline"]);
  return root;
}

function wsOf(root: string): WorkspaceIntel {
  const intel = scanRepo(root, { generatedAt: FIXED_NOW });
  return { rootPath: root, scanVersion: SCAN_VERSION, generatedAt: FIXED_NOW, repos: [intel], knownUnknowns: [] };
}

describe("buildChangeReport", () => {
  let root: string;
  let ws: WorkspaceIntel;
  let name: string;
  beforeEach(() => {
    root = makeGitRepo();
    ws = wsOf(root);
    name = ws.repos[0].name;
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("reports no changes for a clean tree and never claims safe", () => {
    const report = buildChangeReport(ws, { generatedAt: FIXED_NOW, repoRoots: [{ name, rootPath: root }] });
    expect(report.repos[0].summary.total).toBe(0);
    expect(report.verdict).toMatch(/No working-tree changes/);
    expect(report.verdict).not.toMatch(/safe/i);
  });

  it("detects changed code files from live git status", () => {
    writeFileSync(join(root, "src", "server.ts"), 'app.get("/api/x", () => {});\n// changed\n');
    const report = buildChangeReport(ws, { generatedAt: FIXED_NOW, repoRoots: [{ name, rootPath: root }] });
    const r = report.repos[0];
    expect(r.summary.total).toBe(1);
    expect(r.summary.code).toBe(1);
    expect(r.changedFiles[0].path).toBe("src/server.ts");
    expect(r.changedFiles[0].changeKind).toBe("modified");
  });

  it("links a changed file to indexed entities (the route)", () => {
    writeFileSync(join(root, "src", "server.ts"), 'app.get("/api/x", () => {});\n// edit\n');
    const report = buildChangeReport(ws, { generatedAt: FIXED_NOW, repoRoots: [{ name, rootPath: root }] });
    const f = report.repos[0].changedFiles.find((c) => c.path === "src/server.ts")!;
    expect(f.affectedEntities.some((e) => e.kind === "route")).toBe(true);
    expect(report.repos[0].staleWarnings.some((s) => s.includes("src/server.ts"))).toBe(true);
  });

  it("recommends test + lint commands (but marks them not run) for code changes", () => {
    writeFileSync(join(root, "src", "server.ts"), 'app.get("/api/x", () => {});\n// edit\n');
    const report = buildChangeReport(ws, { generatedAt: FIXED_NOW, repoRoots: [{ name, rootPath: root }] });
    const cmds = report.repos[0].recommendedCommands;
    expect(cmds.some((c) => c.category === "test")).toBe(true);
    expect(cmds.some((c) => c.category === "lint")).toBe(true);
    expect(cmds.every((c) => c.runtimeVerified === false)).toBe(true);
    // tests-not-run is an explicit known-unknown
    expect(report.repos[0].knownUnknowns.some((u) => u.title === "tests not run")).toBe(true);
  });

  it("flags deploy-file changes for manual review", () => {
    writeFileSync(join(root, "Dockerfile"), "FROM node:22\n");
    const report = buildChangeReport(ws, { generatedAt: FIXED_NOW, repoRoots: [{ name, rootPath: root }] });
    const r = report.repos[0];
    expect(r.summary.deploy).toBe(1);
    expect(r.manualReview.some((m) => /deployment|CI/i.test(m))).toBe(true);
  });

  it("flags code-without-test changes for manual review", () => {
    writeFileSync(join(root, "src", "server.ts"), 'app.get("/api/x", () => {});\n// edit only code\n');
    const report = buildChangeReport(ws, { generatedAt: FIXED_NOW, repoRoots: [{ name, rootPath: root }] });
    expect(report.repos[0].manualReview.some((m) => /no test files changed/i.test(m))).toBe(true);
  });

  it("records the no-call-graph unknown and a do-not-know-yet entry about flows", () => {
    writeFileSync(join(root, "src", "server.ts"), "// edit\n");
    const report = buildChangeReport(ws, { generatedAt: FIXED_NOW, repoRoots: [{ name, rootPath: root }] });
    expect(report.repos[0].knownUnknowns.some((u) => u.kind === "shallow-graph")).toBe(true);
    expect(report.repos[0].doNotKnowYet.some((d) => /flow/i.test(d))).toBe(true);
  });

  it("handles untracked files", () => {
    writeFileSync(join(root, "src", "new.ts"), "export const x = 1;\n");
    const report = buildChangeReport(ws, { generatedAt: FIXED_NOW, repoRoots: [{ name, rootPath: root }] });
    const f = report.repos[0].changedFiles.find((c) => c.path === "src/new.ts");
    expect(f?.changeKind).toBe("untracked");
  });

  it("renders honest markdown that never says safe and marks commands not run", () => {
    writeFileSync(join(root, "src", "server.ts"), "// edit\n");
    const report = buildChangeReport(ws, { generatedAt: FIXED_NOW, repoRoots: [{ name, rootPath: root }] });
    const md = renderChangeReportMarkdown(report);
    expect(md).toContain("# Change Confidence Report");
    expect(md).toContain("does **NOT** assert the changes are safe");
    expect(md).toContain("NOT run");
    expect(md).toContain("Review manually before pushing");
    expect(md).toContain("Do not know yet");
  });

  it("attaches a safety classification to recommended commands (never auto-runs)", () => {
    writeFileSync(join(root, "src", "server.ts"), 'app.get("/api/x", () => {});\n// edit\n');
    const report = buildChangeReport(ws, { generatedAt: FIXED_NOW, repoRoots: [{ name, rootPath: root }] });
    const cmds = report.repos[0].recommendedCommands;
    expect(cmds.length).toBeGreaterThan(0);
    // every recommended command carries a safety verdict from the shared classifier
    expect(cmds.every((c) => c.safety === "safe-auto" || c.safety === "confirm-required" || c.safety === "blocked")).toBe(true);
    expect(cmds.every((c) => typeof c.mayModify === "boolean")).toBe(true);
    // and is still recommend-only (not executed)
    expect(cmds.every((c) => c.runtimeVerified === false)).toBe(true);
  });
});

describe("buildChangeReport — affected symbols / references", () => {
  let root: string;
  let ws: WorkspaceIntel;
  let name: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "intel-chg-sym-"));
    git(root, ["init"]);
    git(root, ["config", "user.email", "t@t.t"]);
    git(root, ["config", "user.name", "t"]);
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "svc", scripts: { test: "vitest run" } }));
    mkdirSync(join(root, "src"));
    // a function defined in util.ts and called from app.ts (a caller/usage reference)
    writeFileSync(join(root, "src", "util.ts"), "export function computeTotal(x) {\n  return x + 1;\n}\n");
    writeFileSync(join(root, "src", "app.ts"), 'import { computeTotal } from "./util";\nconst t = computeTotal(2);\n');
    git(root, ["add", "-A"]);
    git(root, ["commit", "-m", "baseline"]);
    ws = wsOf(root);
    name = ws.repos[0].name;
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("lists symbols in a changed file and finds their references (inferred, not proven)", () => {
    writeFileSync(join(root, "src", "util.ts"), "export function computeTotal(x) {\n  return x + 2; // changed\n}\n");
    const report = buildChangeReport(ws, { generatedAt: FIXED_NOW, repoRoots: [{ name, rootPath: root }] });
    const r = report.repos[0];
    const sym = r.affectedSymbols.find((s) => s.name === "computeTotal");
    expect(sym).toBeTruthy();
    // the call in app.ts is found as a reference (not the definition itself)
    expect(sym!.references.some((ref) => ref.locator.includes("app.ts") && ref.kind !== "definition")).toBe(true);
    // surfaced as inferred + manual-review, never as a proven call graph
    expect(r.inferredNotes.some((n) => /blast radius|referenced elsewhere/i.test(n))).toBe(true);
    expect(r.manualReview.some((m) => /call sites|not a proven call graph/i.test(m))).toBe(true);
  });

  it("renders the affected-symbols section as INFERRED", () => {
    writeFileSync(join(root, "src", "util.ts"), "export function computeTotal(x) {\n  return x + 2;\n}\n");
    const report = buildChangeReport(ws, { generatedAt: FIXED_NOW, repoRoots: [{ name, rootPath: root }] });
    const md = renderChangeReportMarkdown(report);
    expect(md).toContain("Affected symbols");
    expect(md).toMatch(/INFERRED/);
    expect(md).toContain("computeTotal");
  });
});

describe("buildChangeReport — cross-repo flow impact", () => {
  it("surfaces inferred cross-repo edges touching the changed repo", () => {
    const wsRoot = mkdtempSync(join(tmpdir(), "intel-chg-flow-"));
    try {
      // a real git repo `web` that depends on api's package
      const web = join(wsRoot, "web");
      mkdirSync(web);
      git(web, ["init"]);
      git(web, ["config", "user.email", "t@t.t"]);
      git(web, ["config", "user.name", "t"]);
      writeFileSync(join(web, "package.json"), JSON.stringify({ name: "@acme/web", dependencies: { "@acme/api": "1.0.0" }, scripts: { test: "vitest run" } }));
      mkdirSync(join(web, "src"));
      writeFileSync(join(web, "src", "x.ts"), "export const a = 1;\n");
      git(web, ["add", "-A"]);
      git(web, ["commit", "-m", "baseline"]);
      const webIntel = scanRepo(web, { generatedAt: FIXED_NOW });
      const repoName = webIntel.name; // basename of `web`
      // Build a workspace with an explicit flow map: web → api (shared-package, high)
      const ws: WorkspaceIntel = {
        rootPath: wsRoot, targetPath: wsRoot, scanVersion: SCAN_VERSION, generatedAt: FIXED_NOW,
        repos: [webIntel], knownUnknowns: [],
        flowMap: {
          targetPath: wsRoot, scanVersion: SCAN_VERSION, generatedAt: FIXED_NOW,
          nodes: [{ id: repoName, kind: "repo", label: repoName, repo: repoName }, { id: "api", kind: "repo", label: "api", repo: "api" }],
          edges: [{ from: repoName, to: "api", kind: "shared-package", label: `${repoName} depends on api's package @acme/api`, confidence: "high", evidence: [{ kind: "file", ref: "web/package.json" }] }],
          knownUnknowns: [],
        },
      };
      // make a code change in web
      writeFileSync(join(web, "src", "x.ts"), "export const a = 2;\n");
      const report = buildChangeReport(ws, { generatedAt: FIXED_NOW, repoRoots: [{ name: repoName, rootPath: web }] });
      const r = report.repos[0];
      expect(r.flowImpact.some((e) => e.from === repoName && e.to === "api")).toBe(true);
      expect(r.inferredNotes.some((n) => /cross-repo link/i.test(n))).toBe(true);
      expect(r.manualReview.some((m) => /Cross-repo/i.test(m))).toBe(true);
      const md = renderChangeReportMarkdown(report);
      expect(md).toContain("Cross-repo flow impact");
    } finally {
      rmSync(wsRoot, { recursive: true, force: true });
    }
  });
});
