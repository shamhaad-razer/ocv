// Node / TypeScript / JavaScript adapter. Extracts the prior hardcoded behavior:
// package.json scripts, JS/TS route heuristics, and node/Next service signals.

import type { DetectedScript, DetectedService, Finding } from "../types.js";
import { type Adapter, type AdapterContext, type AdapterResult, categorizeScript, detectRoutesIn, emptyResult, extractSymbolsIn } from "./types.js";

function parsePackageJsonScripts(ctx: AdapterContext): Finding<DetectedScript>[] {
  const out: Finding<DetectedScript>[] = [];
  const raw = ctx.read("package.json");
  if (raw == null) return out;
  try {
    const pkg = JSON.parse(raw) as { scripts?: Record<string, string> };
    for (const [name, command] of Object.entries(pkg.scripts ?? {})) {
      out.push({
        value: { name, command, source: "package.json", category: categorizeScript(name, command) },
        grounding: ctx.ground([{ kind: "file", ref: "package.json", locator: `scripts.${name}`, hash: ctx.fileSource("package.json").hash }], "declared"),
      });
    }
  } catch {
    /* invalid json — handled as a known-unknown by the caller via empty scripts */
  }
  return out;
}

function detectNodeServices(ctx: AdapterContext): Finding<DetectedService>[] {
  const out: Finding<DetectedService>[] = [];
  const nextCfg = ["next.config.ts", "next.config.js"].find((f) => ctx.has(f));
  if (nextCfg) {
    out.push({
      value: { name: "next-frontend", kind: "frontend", evidence: nextCfg, defaultPort: 3000 },
      grounding: ctx.ground([ctx.fileSource(nextCfg)], "declared"),
    });
  }
  const nodeEntry = ctx.files.find((f) => /(^|\/)server\/index\.ts$/.test(f) || /(^|\/)src\/server\.ts$/.test(f));
  if (nodeEntry) {
    out.push({
      value: { name: nodeEntry.replace(/\//g, ":"), kind: "http", evidence: nodeEntry },
      grounding: ctx.ground([ctx.fileSource(nodeEntry)], "heuristic"),
    });
  }
  return out;
}

export const nodeAdapter: Adapter = {
  id: "node",
  description: "Node / TypeScript / JavaScript (package.json scripts, JS/TS routes, Next/node services)",
  appliesTo: (ctx) => ctx.has("package.json"),
  detect: (ctx): AdapterResult => {
    const res = emptyResult("node", "declared", true); // npm/pnpm/yarn runners are verifiable
    res.scripts = parsePackageJsonScripts(ctx);
    res.routes = detectRoutesIn(ctx, /\.(ts|tsx|js|mjs)$/);
    res.services = detectNodeServices(ctx);
    res.symbols = extractSymbolsIn(ctx, /\.(ts|tsx|js|mjs)$/);
    res.evidence = [ctx.fileSource("package.json")];
    if (res.scripts.length === 0) {
      res.knownUnknowns.push({
        id: "node:no-scripts",
        kind: "unvalidated-command",
        title: "package.json has no scripts",
        detail: "package.json present but its `scripts` block is empty or unreadable; run commands may live elsewhere.",
        evidence: [ctx.fileSource("package.json")],
        status: "open",
        confidenceImpact: "medium",
      });
    }
    return res;
  },
};
