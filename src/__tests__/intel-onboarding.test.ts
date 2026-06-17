import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scanRepo } from "../intel/scanner.js";
import { SCAN_VERSION } from "../intel/grounding.js";
import {
  buildCommandBook,
  renderCommandBookMarkdown,
  renderOverview,
  renderRepoOnboarding,
} from "../intel/onboarding.js";
import type { WorkspaceIntel } from "../intel/types.js";

const FIXED_NOW = 1_700_000_000_000;

function makeRepo(opts: { scripts?: Record<string, string>; readme?: boolean; envExample?: boolean; realEnv?: boolean }): string {
  const dir = mkdtempSync(join(tmpdir(), "intel-ob-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "svc", scripts: opts.scripts ?? {} }));
  if (opts.readme) writeFileSync(join(dir, "README.md"), "# Svc\nThis service does things.\n");
  if (opts.envExample) writeFileSync(join(dir, ".env.example"), "API_KEY=\nPORT=3000\n");
  if (opts.realEnv) writeFileSync(join(dir, ".env"), "API_KEY=secret\n");
  return dir;
}

function wsOf(rootPath: string, ...repos: ReturnType<typeof scanRepo>[]): WorkspaceIntel {
  return { rootPath, scanVersion: SCAN_VERSION, generatedAt: FIXED_NOW, repos, knownUnknowns: [] };
}

describe("command book", () => {
  let repo: string;
  beforeEach(() => {
    repo = makeRepo({
      scripts: { dev: "next dev", test: "vitest run", build: "tsc", lint: "eslint .", "db:migrate": "prisma migrate" },
      readme: true,
      envExample: true,
    });
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it("categorizes commands and carries full provenance per entry", () => {
    const book = buildCommandBook(wsOf(repo, scanRepo(repo, { generatedAt: FIXED_NOW })));
    const byCat = (c: string) => book.entries.filter((e) => e.category === c).map((e) => e.name);
    expect(byCat("dev")).toContain("dev");
    expect(byCat("test")).toContain("test");
    expect(byCat("build")).toContain("build");
    expect(byCat("lint")).toContain("lint");
    expect(byCat("database")).toContain("db:migrate");

    const testEntry = book.entries.find((e) => e.name === "test")!;
    expect(testEntry.repo).toBeTruthy();
    expect(testEntry.command).toBe("vitest run");
    expect(testEntry.sourceFile).toBe("package.json");
    expect(testEntry.sourceLocator).toContain("scripts.test");
    expect(testEntry.confidence).toBe("high"); // declared + fresh
    expect(testEntry.freshness).toBe("fresh");
    expect(testEntry.runtimeVerified).toBe(false); // never executed in this MVP
    expect(testEntry.verification).toBe("static");
  });

  it("renders a grouped, honest command book that flags safety + non-verification", () => {
    const md = renderCommandBookMarkdown(buildCommandBook(wsOf(repo, scanRepo(repo, { generatedAt: FIXED_NOW }))));
    expect(md).toContain("# Command Book (generated)");
    expect(md).toContain("not hand-authored truth");
    // verified column shows ✗ for un-run commands; safety column shows a class
    expect(md).toMatch(/safety/);
    expect(md).toMatch(/confirm|safe-auto|never auto-run/);
    expect(md).toMatch(/## install/);
    expect(md).toMatch(/## deploy/);
  });

  it("shows empty categories honestly rather than omitting them", () => {
    const bare = makeRepo({ scripts: { test: "vitest run" }, readme: true });
    try {
      const md = renderCommandBookMarkdown(buildCommandBook(wsOf(bare, scanRepo(bare, { generatedAt: FIXED_NOW }))));
      expect(md).toContain("_no `deploy` commands detected_");
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });
});

describe("onboarding gaps (no false completeness)", () => {
  it("records missing-readme when no README", () => {
    const repo = makeRepo({ scripts: { test: "x" }, readme: false });
    try {
      const intel = scanRepo(repo, { generatedAt: FIXED_NOW });
      expect(intel.knownUnknowns.map((u) => u.kind)).toContain("missing-readme");
      const md = renderRepoOnboarding(intel);
      expect(md).toContain("No README found");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("records missing-test-command when no test script", () => {
    const repo = makeRepo({ scripts: { build: "tsc" }, readme: true });
    try {
      const intel = scanRepo(repo, { generatedAt: FIXED_NOW });
      expect(intel.knownUnknowns.map((u) => u.kind)).toContain("missing-test-command");
      const md = renderRepoOnboarding(intel);
      expect(md).toContain("no test command detected");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("records missing-env-example when .env exists but no example", () => {
    const repo = makeRepo({ scripts: { test: "x" }, readme: true, realEnv: true, envExample: false });
    try {
      const intel = scanRepo(repo, { generatedAt: FIXED_NOW });
      expect(intel.knownUnknowns.map((u) => u.kind)).toContain("missing-env-example");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("per-repo onboarding + overview", () => {
  it("answers the onboarding questions and marks itself generated", () => {
    const repo = makeRepo({ scripts: { dev: "next dev", test: "vitest run" }, readme: true, envExample: true });
    try {
      const md = renderRepoOnboarding(scanRepo(repo, { generatedAt: FIXED_NOW }));
      expect(md).toContain("generated");
      expect(md).toContain("## What is this repo?");
      expect(md).toContain("## How do I install dependencies?");
      expect(md).toContain("## How do I run it locally?");
      expect(md).toContain("## How do I test it?");
      expect(md).toContain("## What is known, inferred, stale, or unknown?");
      // env var names surface, no values
      expect(md).toContain("API_KEY");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("overview tabulates repos and flags that cross-repo wiring is not derived", () => {
    const a = makeRepo({ scripts: { test: "x" }, readme: true });
    const b = makeRepo({ scripts: { dev: "y" }, readme: true });
    try {
      const ws = wsOf("/ws", scanRepo(a, { generatedAt: FIXED_NOW }), scanRepo(b, { generatedAt: FIXED_NOW }));
      const md = renderOverview(ws);
      expect(md).toContain("# Multi-Repo Onboarding Overview (generated)");
      expect(md).toContain("Repos at a glance");
      expect(md).toContain("Cross-repo runtime/contract wiring is not yet derived");
    } finally {
      rmSync(a, { recursive: true, force: true });
      rmSync(b, { recursive: true, force: true });
    }
  });
});
