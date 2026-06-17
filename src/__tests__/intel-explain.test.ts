import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scanRepo } from "../intel/scanner.js";
import { explainSelection, listRepoFiles } from "../intel/explain.js";
import { applyPreferenceUpdate, buildGuidance, defaultPreferences } from "../intel/memory.js";
import { SCAN_VERSION } from "../intel/grounding.js";
import type { WorkspaceIntel } from "../intel/types.js";

const FIXED_NOW = 1_700_000_000_000;

const SERVER_TS = `import { foo } from "./util";

export function handleChat(userId: string) {
  const cleaned = foo(userId);
  app.post("/api/chat", () => {});
  return send(cleaned);
}

export function caller() {
  return handleChat("u1");
}
`;

function makeRepo(): { root: string; ws: WorkspaceIntel } {
  const root = mkdtempSync(join(tmpdir(), "intel-explain-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "svc", scripts: { test: "vitest run" } }));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "server.ts"), SERVER_TS);
  const intel = scanRepo(root, { generatedAt: FIXED_NOW });
  const ws: WorkspaceIntel = {
    rootPath: root,
    scanVersion: SCAN_VERSION,
    generatedAt: FIXED_NOW,
    repos: [intel],
    knownUnknowns: [],
  };
  return { root, ws };
}

describe("explainSelection", () => {
  let root: string;
  let ws: WorkspaceIntel;
  let repoName: string;
  beforeEach(() => {
    ({ root, ws } = makeRepo());
    repoName = ws.repos[0].name; // scanRepo derives the name from the dir basename
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("resolves the enclosing symbol and the selected code", () => {
    const files = listRepoFiles(root);
    const pkg = explainSelection(
      { repo: repoName, path: "src/server.ts", startLine: 4, endLine: 6 },
      ws,
      { generatedAt: FIXED_NOW, repoFiles: files },
    );
    expect(pkg.enclosingSymbol?.name).toBe("handleChat");
    expect(pkg.enclosingSymbol?.kind).toBe("function");
    expect(pkg.selectedCode).toContain("foo(userId)");
  });

  it("detects likely callees inside the selection (heuristic)", () => {
    const pkg = explainSelection(
      { repo: repoName, path: "src/server.ts", startLine: 4, endLine: 6 },
      ws,
      { generatedAt: FIXED_NOW, repoFiles: listRepoFiles(root) },
    );
    const callees = pkg.likelyCallees.map((c) => c.name);
    expect(callees).toContain("foo");
    expect(callees).toContain("send");
    // control-flow keywords are not callees
    expect(callees).not.toContain("return");
  });

  it("detects likely callers via static search", () => {
    const pkg = explainSelection(
      { repo: repoName, path: "src/server.ts", startLine: 3, endLine: 7 },
      ws,
      { generatedAt: FIXED_NOW, repoFiles: listRepoFiles(root) },
    );
    expect(pkg.likelyCallers.some((c) => c.locator.includes("server.ts"))).toBe(true);
  });

  it("links related routes from the index", () => {
    const pkg = explainSelection(
      { repo: repoName, path: "src/server.ts", startLine: 3, endLine: 7 },
      ws,
      { generatedAt: FIXED_NOW, repoFiles: listRepoFiles(root) },
    );
    expect(pkg.related.routes.some((r) => r.pathPattern === "/api/chat")).toBe(true);
  });

  it("never claims high confidence (no real call graph) and records the shallow-graph unknown", () => {
    const pkg = explainSelection(
      { repo: repoName, path: "src/server.ts", startLine: 4, endLine: 6 },
      ws,
      { generatedAt: FIXED_NOW, repoFiles: listRepoFiles(root) },
    );
    expect(pkg.confidence).not.toBe("high");
    expect(pkg.knownUnknowns.some((u) => u.kind === "shallow-graph")).toBe(true);
    expect(pkg.suggestedFollowups.length).toBeGreaterThan(0);
    // evidence + junior-friendly explanation present
    expect(pkg.evidence.sources.length).toBeGreaterThan(0);
    expect(pkg.explanation).toContain("handleChat");
  });

  it("emits a stale warning when the file changed since the scan", () => {
    // mutate the file AFTER the scan recorded its hash
    writeFileSync(join(root, "src", "server.ts"), SERVER_TS + "\n// edited\n");
    const pkg = explainSelection(
      { repo: repoName, path: "src/server.ts", startLine: 4, endLine: 6 },
      ws,
      { generatedAt: FIXED_NOW, repoFiles: listRepoFiles(root) },
    );
    expect(pkg.staleWarning).toBeTruthy();
    expect(pkg.freshness).toBe("potentially-stale");
    expect(pkg.confidence).toBe("low");
  });

  it("degrades honestly for an unknown repo", () => {
    const pkg = explainSelection(
      { repo: "nope", path: "x.ts", startLine: 1, endLine: 1 },
      ws,
      { generatedAt: FIXED_NOW },
    );
    expect(pkg.confidence).toBe("low");
    expect(pkg.enclosingSymbol).toBeNull();
    expect(pkg.knownUnknowns.length).toBeGreaterThan(0);
  });

  it("handles a selection with no enclosing symbol (line-level only)", () => {
    const pkg = explainSelection(
      { repo: repoName, path: "src/server.ts", startLine: 1, endLine: 1 },
      ws,
      { generatedAt: FIXED_NOW, repoFiles: listRepoFiles(root) },
    );
    // line 1 is an import — no enclosing function above it
    expect(pkg.knownUnknowns.some((u) => u.title.includes("enclosing"))).toBe(true);
  });

  // --- prompt 32 additions ---

  it("rejects path traversal outside the target project", () => {
    const pkg = explainSelection(
      { repo: repoName, path: "../../../../etc/passwd", startLine: 1, endLine: 1 },
      ws,
      { generatedAt: FIXED_NOW, repoFiles: listRepoFiles(root) },
    );
    expect(pkg.explanation).toMatch(/outside the target project/);
    expect(pkg.knownUnknowns.some((u) => u.title === "path traversal rejected")).toBe(true);
    expect(pkg.selectedCode).toBe(""); // nothing was read
  });

  it("reports the module/service area + honest call-graph limitation + next steps", () => {
    const pkg = explainSelection(
      { repo: repoName, path: "src/server.ts", startLine: 4, endLine: 6, intent: "what does this do?" },
      ws,
      { generatedAt: FIXED_NOW, repoFiles: listRepoFiles(root) },
    );
    // src/server.ts is detected as a service, so moduleArea prefers the service
    // area over the bare top-level dir.
    expect(pkg.moduleArea).toMatch(/service|src/);
    expect(pkg.explanation).toMatch(/You asked: "what does this do\?"/);
    expect(pkg.explanation).toMatch(/Direct callers are \*\*not yet known\*\*/);
    expect(pkg.explanation).toMatch(/Next, inspect/);
  });

  it("applies remembered guidance: a once-set junior lens is used without re-stating it (prompt 36)", () => {
    const guidance = buildGuidance(defaultPreferences(FIXED_NOW)); // junior by default
    const pkg = explainSelection(
      { repo: repoName, path: "src/server.ts", startLine: 4, endLine: 6 }, // NO experienceLevel on the request
      ws,
      { generatedAt: FIXED_NOW, repoFiles: listRepoFiles(root), guidance },
    );
    // the guidance level was applied + surfaced transparently
    expect(pkg.appliedGuidance?.level).toBe("junior");
    expect(pkg.explanation).toMatch(/Presented for a junior engineer per your saved preferences/);
  });

  it("a senior lens changes the surfaced presentation (preferences drive it)", () => {
    const guidance = buildGuidance(applyPreferenceUpdate(defaultPreferences(FIXED_NOW), { explanationLevel: "senior" }, FIXED_NOW));
    const pkg = explainSelection(
      { repo: repoName, path: "src/server.ts", startLine: 4, endLine: 6 },
      ws,
      { generatedAt: FIXED_NOW, repoFiles: listRepoFiles(root), guidance },
    );
    expect(pkg.appliedGuidance?.level).toBe("senior");
    expect(pkg.explanation).toMatch(/Presented for a senior engineer/);
  });
});
