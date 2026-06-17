import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyEnvironmentOverride,
  autoProbes,
  classifyEnvCheck,
  commandCompatibility,
  effectiveOsVariant,
  effectiveShell,
  loadEnvironmentProfile,
  osVariantOf,
  saveEnvironmentProfile,
  summarizeProfile,
} from "../intel/environment.js";
import { buildGrounding } from "../intel/grounding.js";
import type { EnvironmentProfile, MachineEnv, ToolCheck } from "../intel/types.js";

const NOW = 1_700_000_000_000;

function tool(name: string, available: boolean, version?: string): ToolCheck {
  return {
    name,
    available,
    version,
    probe: `${name} --version`,
    grounding: buildGrounding({ generatedAt: NOW, baseCommit: null, sources: [{ kind: "runtime-check", ref: `${name} --version` }], analysisQuality: "inferred", verification: "runtime-verified" }),
  };
}

function machine(os: string, isWSL: boolean, shell: string | null, tools: ToolCheck[]): MachineEnv {
  return {
    os,
    isWSL,
    shell,
    arch: "x64",
    tools,
    ports: [],
    grounding: buildGrounding({ generatedAt: NOW, baseCommit: null, sources: [{ kind: "runtime-check", ref: "process.platform", locator: os }], analysisQuality: "inferred", verification: "runtime-verified" }),
  };
}

function profileOf(m: MachineEnv): EnvironmentProfile {
  return { version: 1, osVariant: osVariantOf(m), machine: m, workingDirs: [], overrides: {}, refreshedAt: NOW, updatedAt: NOW };
}

describe("osVariantOf — distinguishes WSL/native Windows/macOS/Linux", () => {
  it("maps each platform", () => {
    expect(osVariantOf(machine("linux", true, "/bin/zsh", []))).toBe("wsl");
    expect(osVariantOf(machine("linux", false, "/bin/bash", []))).toBe("linux");
    expect(osVariantOf(machine("win32", false, "pwsh", []))).toBe("windows");
    expect(osVariantOf(machine("darwin", false, "/bin/zsh", []))).toBe("macos");
  });
});

describe("environment overrides persist and win over detection (req #6)", () => {
  let dir: string;
  let path: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "env-prof-"));
    path = join(dir, "environment.json");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("a manually-set shell + os variant override detection and round-trip through disk", () => {
    const p = profileOf(machine("linux", true, "/bin/bash", [tool("node", true, "v20")]));
    // user pins native windows + pwsh
    const overridden = applyEnvironmentOverride(p, { osVariant: "windows", shell: "pwsh" }, NOW + 5);
    saveEnvironmentProfile(overridden, path);
    const reloaded = loadEnvironmentProfile(path)!;
    expect(effectiveOsVariant(reloaded)).toBe("windows"); // override wins
    expect(effectiveShell(reloaded)).toBe("pwsh");
    expect(reloaded.osVariant).toBe("wsl"); // raw detection is preserved underneath
  });

  it("working dirs accumulate and de-dupe", () => {
    let p = profileOf(machine("linux", false, "/bin/zsh", []));
    p = applyEnvironmentOverride(p, { addWorkingDir: "/home/me/proj" }, NOW);
    p = applyEnvironmentOverride(p, { addWorkingDir: "/home/me/proj" }, NOW); // dup
    p = applyEnvironmentOverride(p, { addWorkingDir: "/tmp/other" }, NOW);
    expect(p.workingDirs).toEqual(["/home/me/proj", "/tmp/other"]);
  });

  it("missing profile loads as null (no throw)", () => {
    expect(loadEnvironmentProfile(join(dir, "nope.json"))).toBeNull();
  });
});

describe("classifyEnvCheck — only read-only probes are safe-auto (req #3)", () => {
  it("version probes are safe-auto", () => {
    expect(classifyEnvCheck("node --version").classification).toBe("safe-auto");
    expect(classifyEnvCheck("git --version").classification).toBe("safe-auto");
  });
  it("installs / service starts are NOT safe-auto", () => {
    expect(classifyEnvCheck("npm install").classification).toBe("blocked");
    expect(classifyEnvCheck("docker compose up").classification).not.toBe("safe-auto");
  });
  it("every auto-run probe is classified safe-auto", () => {
    expect(autoProbes().every((p) => p.classification === "safe-auto")).toBe(true);
  });
});

describe("commandCompatibility — recommendations can mention compatibility", () => {
  const wsl = profileOf(machine("linux", true, "/bin/zsh", [tool("node", true, "v20"), tool("uv", false), tool("docker", true, "27.0")]));

  it("flags a missing tool and suggests installing (never auto-runs)", () => {
    const c = commandCompatibility("uv run pytest", wsl);
    expect(c.status).toBe("missing-tool");
    expect(c.tool).toBe("uv");
    expect(c.note).toMatch(/install/i);
  });

  it("reports a present tool as compatible with the machine variant", () => {
    const c = commandCompatibility("docker compose up", wsl);
    expect(c.status).toBe("compatible");
    expect(c.note).toMatch(/wsl/);
  });

  it("flags a PowerShell command on a POSIX (WSL) machine as a shell mismatch", () => {
    const c = commandCompatibility("Get-ChildItem $env:PATH", wsl);
    expect(c.status).toBe("shell-mismatch");
    expect(c.note).toMatch(/PowerShell|POSIX/i);
  });

  it("flags a POSIX command on native Windows as a shell mismatch", () => {
    const win = profileOf(machine("win32", false, "pwsh", [tool("node", true, "v20")]));
    const c = commandCompatibility("export FOO=bar", win);
    expect(c.status).toBe("shell-mismatch");
    expect(c.note).toMatch(/Windows/);
  });

  it("summary mentions the variant and tool presence", () => {
    const s = summarizeProfile(wsl);
    expect(s).toMatch(/wsl/);
    expect(s).toMatch(/node/);
    expect(s).toMatch(/Not found: uv/);
  });
});
