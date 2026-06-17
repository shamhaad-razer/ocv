import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scanRepo } from "../intel/scanner.js";

const NOW = 1_700_000_000_000;

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "adapt-"));
}

describe("Node adapter (existing behavior preserved)", () => {
  let dir: string;
  beforeEach(() => {
    dir = tmp();
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "n", scripts: { dev: "next dev", test: "vitest run", build: "tsc" } }));
    writeFileSync(join(dir, "next.config.ts"), "export default {};\n");
    writeFileSync(join(dir, "src", "server.ts"), 'app.get("/health", () => {});\n');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("detects package.json scripts, a route, and the Next service", () => {
    const r = scanRepo(dir, { generatedAt: NOW });
    expect(r.scripts.map((s) => s.value.name)).toEqual(expect.arrayContaining(["dev", "test", "build"]));
    expect(r.routes.some((x) => x.value.pathPattern === "/health")).toBe(true);
    expect(r.services.some((s) => s.value.name === "next-frontend")).toBe(true);
    // package.json scripts are "declared" → high confidence eligible
    const test = r.scripts.find((s) => s.value.name === "test")!;
    expect(test.grounding.confidence).toBe("high");
  });
});

describe("Python adapter (the breadth improvement)", () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("derives commands from pyproject.toml + uv + pytest/ruff, detects FastAPI routes", () => {
    dir = tmp();
    mkdirSync(join(dir, "app"));
    writeFileSync(
      join(dir, "pyproject.toml"),
      [
        "[project]",
        'name = "svc"',
        "[project.scripts]",
        'svc = "svc.cli:main"',
        "[tool.uv]",
        "[tool.pytest.ini_options]",
        "[tool.ruff]",
      ].join("\n"),
    );
    writeFileSync(join(dir, "uv.lock"), "");
    writeFileSync(join(dir, "app", "main.py"), '@app.get("/users")\ndef users(): ...\n');

    const r = scanRepo(dir, { generatedAt: NOW });
    const names = r.scripts.map((s) => s.value.name);
    expect(names).toContain("svc");        // declared console script
    expect(names).toContain("test");        // pytest runner synthesized
    expect(names).toContain("lint");        // ruff runner synthesized
    expect(names).toContain("install");     // uv sync (uv.lock present)
    const test = r.scripts.find((s) => s.value.name === "test")!;
    expect(test.value.command).toContain("uv run pytest");
    expect(r.routes.some((x) => x.value.pathPattern === "/users")).toBe(true);
    // python now has a test command → no missing-test-command unknown
    expect(r.knownUnknowns.some((u) => u.kind === "missing-test-command")).toBe(false);
  });

  it("requirements.txt yields a pip install command", () => {
    dir = tmp();
    writeFileSync(join(dir, "requirements.txt"), "flask\n");
    writeFileSync(join(dir, "app.py"), '@app.route("/")\ndef home(): ...\n');
    const r = scanRepo(dir, { generatedAt: NOW });
    const install = r.scripts.find((s) => s.value.category === "install");
    expect(install?.value.command).toBe("pip install -r requirements.txt");
  });
});

describe("Go / Rust manifest adapters", () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("Go: synthesizes canonical build/test/run + flags them as synthesized", () => {
    dir = tmp();
    writeFileSync(join(dir, "go.mod"), "module x\n\ngo 1.22\n");
    const r = scanRepo(dir, { generatedAt: NOW });
    expect(r.scripts.map((s) => s.value.command)).toEqual(expect.arrayContaining(["go build ./...", "go test ./...", "go run ."]));
    expect(r.knownUnknowns.some((u) => u.id === "go:synthesized-commands")).toBe(true);
  });

  it("Rust: synthesizes cargo build/test/run", () => {
    dir = tmp();
    writeFileSync(join(dir, "Cargo.toml"), "[package]\nname = \"x\"\n");
    const r = scanRepo(dir, { generatedAt: NOW });
    expect(r.scripts.map((s) => s.value.command)).toEqual(expect.arrayContaining(["cargo build", "cargo test", "cargo run"]));
  });
});

describe("Generic fallback (degrade gracefully)", () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("unknown project type → no commands invented, records unrecognized-project-type", () => {
    dir = tmp();
    writeFileSync(join(dir, "data.csv"), "a,b\n1,2\n");
    writeFileSync(join(dir, "notes.txt"), "hello");
    const r = scanRepo(dir, { generatedAt: NOW });
    expect(r.scripts).toHaveLength(0);
    expect(r.knownUnknowns.some((u) => u.id === "generic:unrecognized-project-type")).toBe(true);
    // still inventories files (coverage) — generic value isn't zero
    expect(r.coverage.filesScanned).toBeGreaterThan(0);
  });
});

describe("Make adapter coexists with a language adapter", () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("a Node repo with a Makefile gets both npm scripts and make targets", () => {
    dir = tmp();
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "n", scripts: { test: "vitest" } }));
    writeFileSync(join(dir, "Makefile"), "deploy:\n\t./deploy.sh\n");
    const r = scanRepo(dir, { generatedAt: NOW });
    expect(r.scripts.some((s) => s.value.source === "package.json")).toBe(true);
    expect(r.scripts.some((s) => s.value.command === "make deploy")).toBe(true);
  });
});
