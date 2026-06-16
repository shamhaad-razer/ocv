import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scanRepo } from "../intel/scanner.js";
import {
  buildGrounding,
  computeConfidence,
  hashContent,
  recheckFreshness,
  SCAN_VERSION,
} from "../intel/grounding.js";
import { renderWorkspaceMarkdown } from "../intel/render.js";
import type { ConfidenceBasis } from "../intel/types.js";

const FIXED_NOW = 1_700_000_000_000; // deterministic injected timestamp

function makeFakeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "intel-repo-"));
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name: "fake-svc",
      scripts: { dev: "next dev", test: "vitest run", lint: "eslint ." },
    }),
  );
  writeFileSync(join(dir, "next.config.ts"), "export default {};\n");
  writeFileSync(join(dir, ".env.example"), "API_KEY=\nDATABASE_URL=\n# comment\nPORT=3000\n");
  writeFileSync(join(dir, "Dockerfile"), "FROM node:20\n");
  mkdirSync(join(dir, "src"));
  writeFileSync(
    join(dir, "src", "server.ts"),
    'app.get("/health", () => {});\nrouter.post("/api/thing", () => {});\n',
  );
  return dir;
}

describe("scanRepo", () => {
  let repo: string;
  beforeEach(() => {
    repo = makeFakeRepo();
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("detects package files, scripts, services, env vars, and deploy files — all grounded", () => {
    const intel = scanRepo(repo, { generatedAt: FIXED_NOW });

    expect(intel.packageFiles.map((p) => p.value)).toContain("package.json");
    expect(intel.languages).toContain("typescript");

    const scriptNames = intel.scripts.map((s) => s.value.name);
    expect(scriptNames).toEqual(expect.arrayContaining(["dev", "test", "lint"]));
    // categorization
    const testScript = intel.scripts.find((s) => s.value.name === "test");
    expect(testScript?.value.category).toBe("test");

    // env vars: names only, comments ignored
    const envNames = intel.envVars.map((v) => v.value.name);
    expect(envNames).toEqual(expect.arrayContaining(["API_KEY", "DATABASE_URL", "PORT"]));

    // deploy file detected
    expect(intel.deployFiles.map((d) => d.value)).toContain("Dockerfile");

    // routes detected heuristically
    expect(intel.routes.length).toBeGreaterThanOrEqual(1);
    const health = intel.routes.find((r) => r.value.pathPattern === "/health");
    expect(health?.value.method).toBe("GET");
  });

  it("grounds every finding with a source reference (no ungrounded facts)", () => {
    const intel = scanRepo(repo, { generatedAt: FIXED_NOW });
    for (const f of [...intel.packageFiles, ...intel.scripts, ...intel.envVars, ...intel.deployFiles]) {
      expect(f.grounding.sources.length).toBeGreaterThan(0);
      expect(f.grounding.scanVersion).toBe(SCAN_VERSION);
      expect(f.grounding.generatedAt).toBe(FIXED_NOW);
    }
  });

  it("declared package facts are high confidence; heuristic routes are capped at medium", () => {
    const intel = scanRepo(repo, { generatedAt: FIXED_NOW });
    const pkg = intel.packageFiles.find((p) => p.value === "package.json");
    expect(pkg?.grounding.confidence).toBe("high");
    for (const r of intel.routes) {
      expect(r.grounding.confidence).not.toBe("high"); // heuristic
    }
  });

  it("always records the shallow-graph and unvalidated-command known unknowns", () => {
    const intel = scanRepo(repo, { generatedAt: FIXED_NOW });
    const kinds = intel.knownUnknowns.map((u) => u.kind);
    expect(kinds).toContain("shallow-graph");
    expect(kinds).toContain("unvalidated-command");
  });

  it("records a missing-deploy-config unknown when no deploy files exist", () => {
    const bare = mkdtempSync(join(tmpdir(), "intel-bare-"));
    writeFileSync(join(bare, "package.json"), JSON.stringify({ name: "bare" }));
    try {
      const intel = scanRepo(bare, { generatedAt: FIXED_NOW });
      expect(intel.knownUnknowns.map((u) => u.kind)).toContain("missing-deploy-config");
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });
});

describe("confidence calculus", () => {
  const base: ConfidenceBasis = {
    sourceCoverage: "complete",
    freshness: "fresh",
    analysisQuality: "declared",
    runtimeVerification: "none",
    missingFiles: [],
  };

  it("declared + fresh + complete = high", () => {
    expect(computeConfidence(base)).toBe("high");
  });
  it("no sources = low", () => {
    expect(computeConfidence({ ...base, sourceCoverage: "none" })).toBe("low");
  });
  it("missing files cap to low", () => {
    expect(computeConfidence({ ...base, missingFiles: ["prod.yaml"] })).toBe("low");
  });
  it("heuristic = medium unless runtime-verified", () => {
    expect(computeConfidence({ ...base, analysisQuality: "heuristic" })).toBe("medium");
    expect(computeConfidence({ ...base, analysisQuality: "heuristic", runtimeVerification: "verified" })).toBe("high");
  });
  it("known-stale = low", () => {
    expect(computeConfidence({ ...base, freshness: "known-stale" })).toBe("low");
  });
});

describe("freshness re-check", () => {
  it("detects content drift and scanVersion bumps", () => {
    const g = buildGrounding({
      generatedAt: FIXED_NOW,
      baseCommit: "abc123",
      sources: [{ kind: "file", ref: "a.ts", hash: hashContent("v1") }],
      analysisQuality: "declared",
    });
    // unchanged
    expect(recheckFreshness(g, () => hashContent("v1")).status).toBe("fresh");
    // changed content
    const changed = recheckFreshness(g, () => hashContent("v2"));
    expect(changed.status).toBe("potentially-stale");
    expect(changed.staleReason).toContain("source changed");
    // missing file
    expect(recheckFreshness(g, () => null).status).toBe("potentially-stale");
    // scanVersion mismatch
    expect(recheckFreshness({ ...g, scanVersion: "0.0.0-old" }, () => hashContent("v1")).status).toBe("known-stale");
  });
});

describe("render", () => {
  it("produces a markdown map with metadata, confidence badges, and known-unknowns", () => {
    const repo = makeFakeRepo();
    try {
      const intel = scanRepo(repo, { generatedAt: FIXED_NOW });
      const md = renderWorkspaceMarkdown({
        rootPath: "/ws",
        scanVersion: SCAN_VERSION,
        generatedAt: FIXED_NOW,
        repos: [intel],
        knownUnknowns: [],
      });
      expect(md).toContain("# Project Intelligence Map (MVP)");
      expect(md).toContain("Known unknowns");
      expect(md).toMatch(/high|medium|low/);
      expect(md).toContain("scan version");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
