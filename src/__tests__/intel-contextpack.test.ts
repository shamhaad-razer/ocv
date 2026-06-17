import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scanRepo } from "../intel/scanner.js";
import { buildContextPack } from "../intel/contextpack.js";
import { buildGuidance, defaultPreferences, applyPreferenceUpdate } from "../intel/memory.js";
import { SCAN_VERSION } from "../intel/grounding.js";
import { projectIdFor } from "../intel/storage.js";
import type { WorkspaceIntel } from "../intel/types.js";

const NOW = 1_700_000_000_000;
const GUIDANCE = buildGuidance(defaultPreferences(NOW)); // junior lens

const ORDERS_TS = `export function computeTotal(items) {
  return items.reduce((a, b) => a + b.price, 0);
}

export function formatOrder(o) {
  return "#" + o.id;
}
`;

const SERVER_TS = `import { computeTotal, formatOrder } from "./orders";

app.get("/api/orders", (req, res) => {
  res.send({ total: computeTotal(req.body.items), label: formatOrder(req.body) });
});
`;

function makeWs(): { root: string; ws: WorkspaceIntel; repo: string } {
  const root = mkdtempSync(join(tmpdir(), "ctxpack-"));
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "shop-api", scripts: { test: "vitest run", lint: "eslint .", build: "tsc", deploy: "echo ship" } }),
  );
  writeFileSync(join(root, "Dockerfile"), "FROM node:20\n");
  writeFileSync(join(root, ".env.example"), "DATABASE_URL=\nJWT_SECRET=\n");
  writeFileSync(join(root, "README.md"), "# shop-api\n");
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "orders.ts"), ORDERS_TS);
  writeFileSync(join(root, "src", "server.ts"), SERVER_TS);
  const intel = scanRepo(root, { generatedAt: NOW });
  const ws: WorkspaceIntel = { rootPath: root, targetPath: root, scanVersion: SCAN_VERSION, generatedAt: NOW, repos: [intel], knownUnknowns: [] };
  return { root, ws, repo: intel.name };
}

describe("buildContextPack", () => {
  let root: string;
  let ws: WorkspaceIntel;
  let repo: string;
  beforeEach(() => {
    ({ root, ws, repo } = makeWs());
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("builds a pack for a question with project metadata + repo summary + preferences", () => {
    const pack = buildContextPack(
      { projectId: projectIdFor(root), question: "how are orders totaled?", repo },
      ws,
      { generatedAt: NOW, guidance: GUIDANCE },
    );
    expect(pack.version).toBe(1);
    expect(pack.items.some((i) => i.kind === "project-metadata")).toBe(true);
    expect(pack.items.some((i) => i.kind === "repo-summary")).toBe(true);
    // user explanation preferences are carried (req: includes preferences)
    expect(pack.guidance.level).toBe("junior");
    expect(pack.summary).toMatch(/junior engineer/);
  });

  it("every item is source-grounded (req #3)", () => {
    const pack = buildContextPack({ projectId: projectIdFor(root), question: "explain the API", repo }, ws, { generatedAt: NOW, guidance: GUIDANCE });
    expect(pack.items.length).toBeGreaterThan(0);
    for (const it of pack.items) expect(it.sources.length).toBeGreaterThan(0);
  });

  it("grounds in code when given a file + line range (explain mode)", () => {
    const pack = buildContextPack(
      { projectId: projectIdFor(root), question: "what does computeTotal do?", repo, filePath: "src/orders.ts", startLine: 1, endLine: 3, mode: "explain" },
      ws,
      { generatedAt: NOW, guidance: GUIDANCE },
    );
    expect(pack.items.some((i) => i.kind === "selected-code")).toBe(true);
    expect(pack.items.some((i) => i.kind === "symbol")).toBe(true);
    // a caller of computeTotal (server.ts) shows up as a reference
    expect(pack.items.some((i) => i.kind === "reference" && i.content.includes("computeTotal"))).toBe(true);
  });

  it("respects the budget and reports what was dropped (req #5)", () => {
    const pack = buildContextPack({ projectId: projectIdFor(root), question: "tell me everything", repo }, ws, { generatedAt: NOW, guidance: GUIDANCE, maxItems: 3 });
    expect(pack.items.length).toBeLessThanOrEqual(3);
    expect(pack.selection.included).toBe(pack.items.length);
    expect(pack.selection.candidates).toBeGreaterThan(pack.items.length);
    expect(pack.selection.droppedForBudget).toBe(pack.selection.candidates - pack.items.length);
  });

  it("the mode steers which kinds are prioritized", () => {
    const deploy = buildContextPack({ projectId: projectIdFor(root), question: "how do I ship this?", repo, mode: "deployment" }, ws, { generatedAt: NOW, guidance: GUIDANCE, maxItems: 8 });
    // deployment mode surfaces the Dockerfile / deploy command
    expect(deploy.items.some((i) => i.kind === "deploy-file" || (i.kind === "command" && /deploy|docker/.test(i.label)))).toBe(true);

    const cmd = buildContextPack({ projectId: projectIdFor(root), question: "how do I run tests?", repo, mode: "command-help" }, ws, { generatedAt: NOW, guidance: GUIDANCE, maxItems: 8 });
    expect(cmd.items.some((i) => i.kind === "command")).toBe(true);
  });

  it("never reads env values — only names (S6)", () => {
    const pack = buildContextPack({ projectId: projectIdFor(root), question: "what env vars are needed?", repo, mode: "deployment" }, ws, { generatedAt: NOW, guidance: GUIDANCE, maxItems: 30 });
    const envItems = pack.items.filter((i) => i.kind === "env-var");
    expect(envItems.length).toBeGreaterThan(0);
    expect(envItems.some((i) => i.content.includes("DATABASE_URL"))).toBe(true);
    expect(envItems.every((i) => i.content.includes("value never read"))).toBe(true);
  });

  it("marks stale/uncertain context and never over-claims overall confidence (req #4)", () => {
    // edit orders.ts after the scan so the selection is detected as stale
    writeFileSync(join(root, "src", "orders.ts"), ORDERS_TS + "\n// changed after scan\n");
    const pack = buildContextPack(
      { projectId: projectIdFor(root), question: "did this change?", repo, filePath: "src/orders.ts", startLine: 1, endLine: 3, mode: "explain" },
      ws,
      { generatedAt: NOW, guidance: GUIDANCE },
    );
    expect(pack.items.some((i) => i.uncertain)).toBe(true);
    // overall confidence is the worst included item — never "high" when uncertain items exist
    expect(["low", "medium"]).toContain(pack.confidence);
  });

  it("is honest when explain mode has no selection", () => {
    const pack = buildContextPack({ projectId: projectIdFor(root), question: "explain it", repo, mode: "explain" }, ws, { generatedAt: NOW, guidance: GUIDANCE });
    expect(pack.knownUnknowns.some((u) => u.id === "contextpack:no-selection")).toBe(true);
  });

  it("a senior preference is reflected in the pack guidance", () => {
    const senior = buildGuidance(applyPreferenceUpdate(defaultPreferences(NOW), { explanationLevel: "senior" }, NOW));
    const pack = buildContextPack({ projectId: projectIdFor(root), question: "explain", repo }, ws, { generatedAt: NOW, guidance: senior });
    expect(pack.guidance.level).toBe("senior");
    expect(pack.summary).toMatch(/senior engineer/);
  });

  it("deployment mode folds in the deployment report (signals + production-unknown)", () => {
    const pack = buildContextPack({ projectId: projectIdFor(root), question: "how is this deployed?", repo, mode: "deployment" }, ws, { generatedAt: NOW, guidance: GUIDANCE, maxItems: 30 });
    // the Dockerfile signal surfaces as a deploy-file item
    expect(pack.items.some((i) => i.kind === "deploy-file" && /dockerfile/i.test(i.label))).toBe(true);
    // and the honesty: production deployment is flagged unknown
    expect(pack.items.some((i) => i.kind === "known-unknown" && /production deployment/i.test(i.label))).toBe(true);
  });
});
