import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scanRepo } from "../intel/scanner.js";
import { buildMirrorReport } from "../intel/mirror.js";
import { renderMirrorReportMarkdown } from "../intel/render.js";
import { SCAN_VERSION } from "../intel/grounding.js";
import type { RepoIntel } from "../intel/types.js";

const NOW = 1_700_000_000_000;

/** A "well-equipped" node source repo: Dockerfile, CI, eslint, env example, README, test/lint/build. */
function makeSource(): { root: string; intel: RepoIntel } {
  const root = mkdtempSync(join(tmpdir(), "mirror-src-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "source-svc", scripts: { test: "vitest run", lint: "eslint .", build: "tsc", deploy: "kubectl apply -f k8s" } }));
  writeFileSync(join(root, "Dockerfile"), "FROM node:20\nEXPOSE 4000\n");
  writeFileSync(join(root, ".eslintrc.json"), "{}\n");
  writeFileSync(join(root, ".env.example"), "DATABASE_URL=\nJWT_SECRET=\n");
  writeFileSync(join(root, "README.md"), "# source-svc\n");
  mkdirSync(join(root, ".github", "workflows"), { recursive: true });
  writeFileSync(join(root, ".github", "workflows", "ci.yml"), "name: ci\non: [push]\n");
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "index.ts"), "export const x = 1;\n");
  return { root, intel: scanRepo(root, { generatedAt: NOW }) };
}

/** A "bare" node target repo: only package.json with build, missing most conventions. */
function makeBareTarget(): { root: string; intel: RepoIntel } {
  const root = mkdtempSync(join(tmpdir(), "mirror-tgt-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "target-svc", scripts: { build: "tsc" } }));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "index.ts"), "export const y = 2;\n");
  return { root, intel: scanRepo(root, { generatedAt: NOW }) };
}

describe("buildMirrorReport — same ecosystem (node ⇐ node)", () => {
  let src: { root: string; intel: RepoIntel };
  let tgt: { root: string; intel: RepoIntel };
  beforeEach(() => {
    src = makeSource();
    tgt = makeBareTarget();
  });
  afterEach(() => {
    rmSync(src.root, { recursive: true, force: true });
    rmSync(tgt.root, { recursive: true, force: true });
  });

  it("flags missing conventions as safe-to-align (eslint, env example, README)", () => {
    const r = buildMirrorReport(src.intel, tgt.intel, { generatedAt: NOW, scanVersion: SCAN_VERSION });
    const safe = r.findings.filter((f) => f.intent === "safe-to-align").map((f) => f.role);
    expect(safe).toContain("eslint config");
    expect(safe).toContain("env example");
    expect(safe).toContain("README");
  });

  it("flags missing test/lint commands as worth-aligning (align the role, not the literal)", () => {
    const r = buildMirrorReport(src.intel, tgt.intel, { generatedAt: NOW, scanVersion: SCAN_VERSION });
    const worth = r.findings.filter((f) => f.intent === "worth-aligning").map((f) => f.role);
    expect(worth).toContain("test command");
    expect(worth).toContain("lint command");
    // build exists in both → not proposed
    expect(worth).not.toContain("build command");
  });

  it("flags CI + Dockerfile as high-scrutiny with explicit risk (req #4)", () => {
    const r = buildMirrorReport(src.intel, tgt.intel, { generatedAt: NOW, scanVersion: SCAN_VERSION });
    const hi = r.findings.filter((f) => f.intent === "high-scrutiny");
    expect(hi.some((f) => /Actions|CI/i.test(f.role))).toBe(true);
    expect(hi.some((f) => f.role === "Dockerfile")).toBe(true);
    for (const f of hi) expect(f.risk.length).toBeGreaterThan(0); // each says what could break
  });

  it("treats env VALUES as out-of-scope (S6) and cites source files (req #3)", () => {
    const r = buildMirrorReport(src.intel, tgt.intel, { generatedAt: NOW, scanVersion: SCAN_VERSION });
    expect(r.findings.some((f) => f.intent === "out-of-scope" && f.role === "env values")).toBe(true);
    // every non-empty finding cites source evidence
    for (const f of r.findings) {
      if (f.source) expect(f.sources.length).toBeGreaterThan(0);
    }
  });

  it("produces a dry-run plan sorted low→high risk, with validation hand-off (req #5/#7)", () => {
    const r = buildMirrorReport(src.intel, tgt.intel, { generatedAt: NOW, scanVersion: SCAN_VERSION });
    expect(r.plan.length).toBeGreaterThan(0);
    const order = { low: 0, medium: 1, high: 2 };
    for (let i = 1; i < r.plan.length; i++) expect(order[r.plan[i].risk]).toBeGreaterThanOrEqual(order[r.plan[i - 1].risk]);
    // change-confidence hand-off is present
    expect(r.validation.some((v) => /change-confidence|report --target/i.test(v))).toBe(true);
    // and recommends the target's own checks
    expect(r.validation.some((v) => /build/i.test(v))).toBe(true);
  });

  it("renders a propose-only report that never claims it modified anything", () => {
    const r = buildMirrorReport(src.intel, tgt.intel, { generatedAt: NOW, scanVersion: SCAN_VERSION });
    const md = renderMirrorReportMarkdown(r);
    expect(md).toContain("# Repo Mirroring Report");
    expect(md).toMatch(/PROPOSE-ONLY/);
    expect(md).toContain("Dry-run plan");
    expect(md).toContain("Validation steps");
    expect(md).toContain("Out of scope");
  });
});

describe("buildMirrorReport — cross ecosystem (python target ⇐ node source)", () => {
  it("does NOT propose copying node-specific files into a python target (ecosystem rail)", () => {
    const src = makeSource();
    const pyRoot = mkdtempSync(join(tmpdir(), "mirror-py-"));
    writeFileSync(join(pyRoot, "pyproject.toml"), "[project]\nname = 'pysvc'\n");
    mkdirSync(join(pyRoot, "app"));
    writeFileSync(join(pyRoot, "app", "main.py"), "x = 1\n");
    const py = scanRepo(pyRoot, { generatedAt: NOW });
    try {
      const r = buildMirrorReport(src.intel, py, { generatedAt: NOW, scanVersion: SCAN_VERSION });
      expect(r.sameEcosystem).toBe(false);
      // tsconfig/eslint should be out-of-scope, not safe-to-align, for a python target
      const eslint = r.findings.find((f) => f.role === "eslint config");
      if (eslint) expect(eslint.intent).toBe("out-of-scope");
      // cross-ecosystem known-unknown recorded
      expect(r.knownUnknowns.some((u) => u.id === "mirror:cross-ecosystem")).toBe(true);
      // a test-command finding should be intentionally-kept (ecosystem-forced), not blindly aligned
      const testCmd = r.findings.find((f) => f.role === "test command");
      if (testCmd && testCmd.status === "divergent") expect(testCmd.intent).toBe("intentionally-kept");
    } finally {
      rmSync(src.root, { recursive: true, force: true });
      rmSync(pyRoot, { recursive: true, force: true });
    }
  });
});
