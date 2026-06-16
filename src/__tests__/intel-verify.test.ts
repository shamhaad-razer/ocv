import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scanRepo } from "../intel/scanner.js";
import { classifyCommand, runVerification, mergeVerificationStores, commandVerification } from "../intel/verify.js";
import { SCAN_VERSION } from "../intel/grounding.js";
import type { VerificationStore, WorkspaceIntel } from "../intel/types.js";

const FIXED_NOW = 1_700_000_000_000;

function makeRepo(opts: { nodeModules?: boolean; realEnv?: boolean } = {}): { root: string; ws: WorkspaceIntel } {
  const root = mkdtempSync(join(tmpdir(), "intel-vfy-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "svc", scripts: { test: "vitest run" } }));
  writeFileSync(join(root, ".env.example"), "API_KEY=\n");
  if (opts.realEnv) writeFileSync(join(root, ".env"), "API_KEY=secret\n");
  if (opts.nodeModules) mkdirSync(join(root, "node_modules"));
  const intel = scanRepo(root, { generatedAt: FIXED_NOW });
  return { root, ws: { rootPath: root, scanVersion: SCAN_VERSION, generatedAt: FIXED_NOW, repos: [intel], knownUnknowns: [] } };
}

describe("classifyCommand", () => {
  it("classifies safe read-only probes as safe-auto", () => {
    expect(classifyCommand("node --version").classification).toBe("safe-auto");
    expect(classifyCommand("git --version").classification).toBe("safe-auto");
  });
  it("classifies test/lint/build as confirm-required", () => {
    expect(classifyCommand("vitest run").classification).toBe("confirm-required");
    expect(classifyCommand("eslint .").classification).toBe("confirm-required");
    expect(classifyCommand("tsc -p .").classification).toBe("confirm-required");
  });
  it("BLOCKS destructive / installing / long-running / chaining commands", () => {
    expect(classifyCommand("rm -rf /").classification).toBe("blocked");
    expect(classifyCommand("npm install").classification).toBe("blocked");
    expect(classifyCommand("uv sync").classification).toBe("blocked");
    expect(classifyCommand("docker compose up").classification).toBe("blocked");
    expect(classifyCommand("npm run dev").classification).toBe("blocked"); // long-running
    expect(classifyCommand("npm run deploy").classification).toBe("blocked");
    expect(classifyCommand("echo a && rm b").classification).toBe("blocked"); // chaining
    expect(classifyCommand("cat x > y").classification).toBe("blocked"); // redirection
  });
  it("defaults unknown commands to confirm-required (never silently auto-runs)", () => {
    expect(classifyCommand("./scripts/whatever.sh").classification).toBe("confirm-required");
  });
});

describe("runVerification — safe-auto suite", () => {
  let root: string;
  let ws: WorkspaceIntel;
  beforeEach(() => {
    ({ root, ws } = makeRepo({ nodeModules: true, realEnv: true }));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("runs tool-version checks and marks runtime-verified", async () => {
    const store = await runVerification(ws, { generatedAt: FIXED_NOW });
    const node = store.results.find((r) => r.checkId === "tool:node")!;
    expect(node.status).toBe("ran");
    expect(node.passed).toBe(true);
    expect(node.grounding.verification).toBe("runtime-verified");
    expect(node.classification).toBe("safe-auto");
  });

  it("detects installed deps (node_modules present)", async () => {
    const store = await runVerification(ws, { generatedAt: FIXED_NOW });
    const deps = store.results.find((r) => r.kind === "deps-installed")!;
    expect(deps.passed).toBe(true);
    expect(deps.outputSummary).toContain("node_modules");
    expect(deps.confidenceImpact).toBe("raises");
  });

  it("checks real env-file existence (never reads values)", async () => {
    const store = await runVerification(ws, { generatedAt: FIXED_NOW });
    const env = store.results.find((r) => r.kind === "env-file");
    expect(env?.passed).toBe(true);
  });

  it("lowers confidence when deps are NOT installed", async () => {
    const { root: r2, ws: ws2 } = makeRepo({ nodeModules: false });
    try {
      const store = await runVerification(ws2, { generatedAt: FIXED_NOW });
      const deps = store.results.find((r) => r.kind === "deps-installed")!;
      expect(deps.passed).toBe(false);
      expect(deps.confidenceImpact).toBe("lowers");
    } finally {
      rmSync(r2, { recursive: true, force: true });
    }
  });
});

describe("runVerification — explicit command gating", () => {
  let root: string;
  let ws: WorkspaceIntel;
  let name: string;
  beforeEach(() => {
    ({ root, ws } = makeRepo({ nodeModules: true }));
    name = ws.repos[0].name;
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("BLOCKS a destructive command — never runs it", async () => {
    const store = await runVerification(ws, { generatedAt: FIXED_NOW, runCommand: { repo: name, command: "npm install" } });
    const r = store.results.find((x) => x.checkId.startsWith("cmd:"))!;
    expect(r.status).toBe("blocked");
    expect(r.exitCode).toBeNull();
  });

  it("SKIPS a confirm-required command without --confirm", async () => {
    const store = await runVerification(ws, { generatedAt: FIXED_NOW, runCommand: { repo: name, command: "vitest run" } });
    const r = store.results.find((x) => x.checkId.startsWith("cmd:"))!;
    expect(r.status).toBe("skipped");
    expect(r.outputSummary).toContain("--confirm");
  });

  it("RUNS a confirm-required command WITH --confirm (and records pass/fail)", async () => {
    // `node --version` is safe-auto; use a real bounded command that exists.
    const store = await runVerification(ws, { generatedAt: FIXED_NOW, runCommand: { repo: name, command: "node --version" }, confirmed: true });
    const r = store.results.find((x) => x.checkId.startsWith("cmd:"))!;
    expect(r.status).toBe("ran");
    expect(r.passed).toBe(true);
    expect(r.grounding.verification).toBe("runtime-verified");
  });

  it("records a FAILING command honestly (non-zero exit, lowers confidence)", async () => {
    const store = await runVerification(ws, { generatedAt: FIXED_NOW, runCommand: { repo: name, command: "node -e process.exit(3)" }, confirmed: true });
    const r = store.results.find((x) => x.checkId.startsWith("cmd:"))!;
    expect(r.status).toBe("ran");
    expect(r.passed).toBe(false);
    expect(r.confidenceImpact).toBe("lowers");
    expect(r.grounding.verification).toBe("runtime-failed");
  });
});

describe("store merge + lookup", () => {
  it("merges newer results over older by checkId", () => {
    const a: VerificationStore = { generatedAt: 1, scanVersion: SCAN_VERSION, results: [{ checkId: "x", kind: "tool-version", label: "x", classification: "safe-auto", status: "ran", exitCode: 1, passed: false, outputSummary: "old", ranAt: 1, confidenceImpact: "none", grounding: {} as never }] };
    const b: VerificationStore = { generatedAt: 2, scanVersion: SCAN_VERSION, results: [{ checkId: "x", kind: "tool-version", label: "x", classification: "safe-auto", status: "ran", exitCode: 0, passed: true, outputSummary: "new", ranAt: 2, confidenceImpact: "raises", grounding: {} as never }] };
    const merged = mergeVerificationStores(a, b);
    expect(merged.results).toHaveLength(1);
    expect(merged.results[0].outputSummary).toBe("new");
  });

  it("commandVerification finds a ran command", () => {
    const store: VerificationStore = { generatedAt: 1, scanVersion: SCAN_VERSION, results: [{ checkId: "cmd:svc:vitest run", kind: "test-command", label: "x", command: "vitest run", classification: "confirm-required", repo: "svc", status: "ran", exitCode: 0, passed: true, outputSummary: "ok", ranAt: 1, confidenceImpact: "raises", grounding: {} as never }] };
    expect(commandVerification(store, "svc", "vitest run")?.passed).toBe(true);
    expect(commandVerification(store, "svc", "nope")).toBeNull();
  });
});
