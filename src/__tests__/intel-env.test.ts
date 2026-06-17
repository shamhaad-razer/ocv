import { describe, expect, it } from "vitest";
import { detectMachineEnv, deriveSetupCompatibility, toolForCommand } from "../intel/env.js";
import { SCAN_VERSION } from "../intel/grounding.js";
import type { WorkspaceIntel } from "../intel/types.js";

const FIXED_NOW = 1_700_000_000_000;

describe("detectMachineEnv (safe probes)", () => {
  it("detects os/arch/shell and runs runtime-verified tool probes", async () => {
    const { env, unknowns } = await detectMachineEnv({ generatedAt: FIXED_NOW });
    expect(["linux", "darwin", "win32"]).toContain(env.os);
    expect(env.arch).toBeTruthy();
    // node + git are running this very test, so they MUST be detected + versioned.
    const node = env.tools.find((t) => t.name === "node")!;
    expect(node.available).toBe(true);
    expect(node.version).toMatch(/\d+\.\d+/);
    expect(node.grounding.verification).toBe("runtime-verified");
    expect(node.grounding.confidence).toBe("high"); // inferred + runtime-verified → high
    // every tool check cites the exact probe command (provenance)
    for (const t of env.tools) {
      expect(t.probe).toContain(t.name === "python" ? "python3" : t.name === "docker" ? "docker" : t.name);
      expect(t.grounding.sources[0].kind).toBe("runtime-check");
    }
    // ports not checked by default → recorded as an unverified-port known-unknown
    expect(unknowns.some((u) => u.kind === "unverified-port")).toBe(true);
    expect(env.ports).toEqual([]);
  });

  it("does not check ports unless asked, and check is opt-in", async () => {
    const { env, unknowns } = await detectMachineEnv({ generatedAt: FIXED_NOW, checkPorts: [0] });
    // port 0 binds to an ephemeral free port → "free", and no unverified-port unknown
    expect(env.ports.length).toBe(1);
    expect(["free", "occupied", "unknown"]).toContain(env.ports[0].state);
    expect(unknowns.some((u) => u.kind === "unverified-port")).toBe(false);
  });

  it("env grounding is runtime-verified", async () => {
    const { env } = await detectMachineEnv({ generatedAt: FIXED_NOW });
    expect(env.grounding.verification).toBe("runtime-verified");
    expect(env.grounding.generatedAt).toBe(FIXED_NOW);
  });
});

describe("toolForCommand", () => {
  it("maps command text to the tool it needs", () => {
    expect(toolForCommand("npm run dev")).toBe("npm");
    expect(toolForCommand("npx tsx server.ts")).toBe("npm");
    expect(toolForCommand("uv run bot.py")).toBe("uv");
    expect(toolForCommand("python3 -m pytest")).toBe("python");
    expect(toolForCommand("docker compose up")).toBe("docker");
    expect(toolForCommand("make build")).toBe("make");
    expect(toolForCommand("./scripts/weird.sh")).toBeNull();
  });
});

describe("deriveSetupCompatibility", () => {
  function wsWith(env: WorkspaceIntel["machineEnv"]): WorkspaceIntel {
    return {
      rootPath: "/ws",
      scanVersion: SCAN_VERSION,
      generatedAt: FIXED_NOW,
      machineEnv: env,
      knownUnknowns: [],
      repos: [
        {
          name: "node-repo",
          rootPath: "/ws/node-repo",
          gitBranch: "main",
          gitCommit: "abc",
          isGitRepo: true,
          languages: ["typescript"],
          coverage: { filesScanned: 1, dirsScanned: [], dirsSkipped: [], truncated: false, maxFiles: 5000 },
          importantDirs: [],
          packageFiles: [],
          docFiles: [],
          scripts: [
            { value: { name: "dev", command: "npm run dev", source: "package.json", category: "dev-server" }, grounding: {} as never },
            { value: { name: "voice", command: "uv run bot.py", source: "package.json", category: "dev-server" }, grounding: {} as never },
          ],
          services: [],
          routes: [],
          symbols: [],
          envFiles: [],
          envVars: [],
          deployFiles: [],
          knownUnknowns: [],
          grounding: {} as never,
        },
      ],
    };
  }

  it("flags missing tools and lists present ones", async () => {
    // Build a real env, then force a tool missing for the assertion.
    const { env } = await detectMachineEnv({ generatedAt: FIXED_NOW });
    const tweaked = {
      ...env!,
      tools: env!.tools.map((t) => (t.name === "uv" ? { ...t, available: false } : { ...t, available: t.name === "npm" ? true : t.available })),
    };
    const compat = deriveSetupCompatibility(wsWith(tweaked));
    const repo = compat[0];
    // npm command → present (npm is on this machine); uv command → missing (forced)
    expect(repo.toolsMissing).toContain("uv");
    expect(repo.notes.some((n) => n.includes("uv"))).toBe(true);
  });

  it("returns empty when no machineEnv is present", () => {
    const ws = wsWith(undefined);
    expect(deriveSetupCompatibility(ws)).toEqual([]);
  });
});
