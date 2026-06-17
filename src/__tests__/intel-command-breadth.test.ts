import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scanRepo } from "../intel/scanner.js";
import { buildCommandBook } from "../intel/onboarding.js";
import { SCAN_VERSION } from "../intel/grounding.js";
import type { WorkspaceIntel } from "../intel/types.js";

const NOW = 1_700_000_000_000;
const wsOf = (root: string, intel: ReturnType<typeof scanRepo>): WorkspaceIntel => ({
  rootPath: root, targetPath: root, scanVersion: SCAN_VERSION, generatedAt: NOW, repos: [intel], knownUnknowns: [],
});

describe("expanded command sources (prompt 31)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cmd-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("detects shell scripts under scripts/ and top-level *.sh", () => {
    mkdirSync(join(dir, "scripts"));
    writeFileSync(join(dir, "scripts", "deploy.sh"), "#!/bin/sh\necho deploy\n");
    writeFileSync(join(dir, "run.sh"), "#!/bin/sh\necho run\n");
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x" })); // node so it's a type
    const r = scanRepo(dir, { generatedAt: NOW });
    const cmds = r.scripts.map((s) => s.value.command);
    expect(cmds).toContain("./scripts/deploy.sh");
    expect(cmds).toContain("./run.sh");
  });

  it("detects commands from README fenced shell blocks", () => {
    writeFileSync(
      join(dir, "README.md"),
      ["# Proj", "```bash", "$ npm install", "uv run pytest", "this is prose not a command", "```", ""].join("\n"),
    );
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x" }));
    const r = scanRepo(dir, { generatedAt: NOW });
    const cmds = r.scripts.map((s) => s.value.command);
    expect(cmds).toContain("npm install");        // "$ " stripped
    expect(cmds).toContain("uv run pytest");
    expect(cmds).not.toContain("this is prose not a command"); // not a runner → ignored
  });

  it("detects docker-compose services as docker commands", () => {
    writeFileSync(
      join(dir, "docker-compose.yml"),
      ["services:", "  web:", "    image: nginx", "  db:", "    image: postgres", ""].join("\n"),
    );
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x" }));
    const r = scanRepo(dir, { generatedAt: NOW });
    const cmds = r.scripts.map((s) => s.value.command);
    expect(cmds).toContain("docker compose up web");
    expect(cmds).toContain("docker compose up db");
  });
});

describe("safety classification per command (prompt 31)", () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("classifies safe-auto / confirm / blocked + mayModify + envAssumptions", () => {
    dir = mkdtempSync(join(tmpdir(), "cmd-"));
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({
        name: "x",
        scripts: {
          test: "vitest run",        // confirm-required, modifies (runs)
          ver: "node --version",     // safe-auto, read-only
          setup: "npm install",      // blocked (installs)
        },
      }),
    );
    const book = buildCommandBook(wsOf(dir, scanRepo(dir, { generatedAt: NOW })));
    const byName = (n: string) => book.entries.find((e) => e.name === n)!;

    const ver = byName("ver");
    expect(ver.safety).toBe("safe-auto");
    expect(ver.safeToRunAutomatically).toBe(true);
    expect(ver.mayModify).toBe(false);
    expect(ver.envAssumptions).toContain("node");

    const test = byName("test");
    expect(test.safety).toBe("confirm-required");
    expect(test.confirmationRequired).toBe(true);
    expect(test.mayModify).toBe(true);

    const setup = byName("setup");
    expect(setup.safety).toBe("blocked");      // npm install → never auto-run
    expect(setup.safeToRunAutomatically).toBe(false);
    expect(setup.mayModify).toBe(true);
  });

  it("read-only inspect commands are not flagged as modifying", () => {
    dir = mkdtempSync(join(tmpdir(), "cmd-"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x", scripts: { status: "git status" } }));
    const book = buildCommandBook(wsOf(dir, scanRepo(dir, { generatedAt: NOW })));
    const status = book.entries.find((e) => e.name === "status")!;
    expect(status.category).toBe("inspect");
    expect(status.mayModify).toBe(false);
  });
});
