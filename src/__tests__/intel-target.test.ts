import { execFileSync as buildSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// End-to-end CLI test for the host-vs-target correction (prompt 23): scanning an
// EXTERNAL target writes the index to HOST storage and NEVER into the target.
// Runs the built dist-scan/cli.mjs as a subprocess (the real edge).

const repoRoot = join(__dirname, "..", "..");
const cli = join(repoRoot, "dist-scan", "cli.mjs");

let target: string;
let out: string;

function run(args: string[], env?: NodeJS.ProcessEnv): { code: number; stdout: string; stderr: string } {
  // spawnSync captures BOTH streams regardless of exit code (the CLI logs
  // progress to stderr, JSON to stdout).
  const r = spawnSync("node", [cli, ...args], { encoding: "utf-8", env: { ...process.env, ...env } });
  return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

beforeAll(() => {
  // Build the CLI bundle so the subprocess test runs the current source.
  buildSync("node", [join(repoRoot, "build-scan.mjs")], { stdio: "ignore" });

  target = mkdtempSync(join(tmpdir(), "ext-target-"));
  mkdirSync(join(target, "svc", "src"), { recursive: true });
  writeFileSync(join(target, "svc", "package.json"), JSON.stringify({ name: "svc", scripts: { test: "vitest run" } }));
  writeFileSync(join(target, "svc", "src", "x.ts"), 'export function f() { return g(); }\n');

  out = mkdtempSync(join(tmpdir(), "host-out-"));
});

afterAll(() => {
  rmSync(target, { recursive: true, force: true });
  rmSync(out, { recursive: true, force: true });
});

describe("CLI host-vs-target separation", () => {
  it("validates that a non-existent target is rejected", () => {
    const r = run(["scan", "--target", "/no/such/path/xyz", "--out", out]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/does not exist/);
  });

  it("scans an external target and writes the index to HOST --out (not the target)", () => {
    const r = run(["scan", "--target", target, "--out", out]);
    expect(r.code).toBe(0);
    expect(r.stderr).toContain(`target project: ${target}`);
    // index landed in host out:
    expect(existsSync(join(out, "project-intel.json"))).toBe(true);
    // and the target has NO .openclaw artifacts:
    expect(readdirSync(target).some((n) => n.startsWith(".openclaw"))).toBe(false);
  });

  it("records the target path in the index", () => {
    run(["scan", "--target", target, "--out", out]);
    const ws = JSON.parse(readFileSync(join(out, "project-intel.json"), "utf-8"));
    expect(ws.targetPath).toBe(target);
    expect(ws.repos.map((x: { name: string }) => x.name)).toContain("svc");
  });

  it("explains a file in the external target", () => {
    run(["scan", "--target", target, "--out", out]);
    const r = run(["explain", "svc/src/x.ts:1-1", "--target", target, "--out", out]);
    expect(r.code).toBe(0);
    const pkg = JSON.parse(r.stdout);
    expect(pkg.enclosingSymbol?.name).toBe("f");
    expect(pkg.likelyCallees.map((c: { name: string }) => c.name)).toContain("g");
  });

  it("with no --out, defaults to HOST storage under ~/.openclaw-intel (never the target)", () => {
    // Use a temp HOME so the default-out scan doesn't pollute the real home.
    const fakeHome = mkdtempSync(join(tmpdir(), "fake-home-"));
    try {
      const r = run(["scan", "--target", target], { HOME: fakeHome });
      expect(r.stderr).toMatch(/HOST storage/);
      // index landed under the fake HOME's .openclaw-intel, NOT in the target:
      expect(existsSync(join(fakeHome, ".openclaw-intel"))).toBe(true);
      expect(readdirSync(target).some((n) => n.startsWith(".openclaw"))).toBe(false);
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  // Regression (prompt 25): a SINGLE-REPO target — the target path IS the repo,
  // not a parent of repos. Previously "no repos found"; now detected as ".".
  it("scans a single-repo target (target path itself is the repo)", () => {
    const single = mkdtempSync(join(tmpdir(), "single-repo-"));
    const singleOut = mkdtempSync(join(tmpdir(), "single-out-"));
    try {
      mkdirSync(join(single, "src"), { recursive: true });
      writeFileSync(join(single, "package.json"), JSON.stringify({ name: "solo", scripts: { test: "vitest run" } }));
      writeFileSync(join(single, "src", "a.ts"), "export function h() { return k(); }\n");

      const scan = run(["scan", "--target", single, "--out", singleOut]);
      expect(scan.code).toBe(0);
      const ws = JSON.parse(readFileSync(join(singleOut, "project-intel.json"), "utf-8"));
      expect(ws.repos).toHaveLength(1);
      // repo name is the target's basename, rootPath is the target itself
      expect(ws.repos[0].rootPath).toBe(single);

      const repoName = ws.repos[0].name;
      const ex = run(["explain", `${repoName}/src/a.ts:1-1`, "--target", single, "--out", singleOut]);
      expect(ex.code).toBe(0);
      expect(JSON.parse(ex.stdout).enclosingSymbol?.name).toBe("h");

      // target untouched
      expect(readdirSync(single).some((n) => n.startsWith(".openclaw"))).toBe(false);
    } finally {
      rmSync(single, { recursive: true, force: true });
      rmSync(singleOut, { recursive: true, force: true });
    }
  });
});
