// Adapter registry + runner (prompt 30). The scanner calls `runAdapters`, which
// applies every adapter whose `appliesTo` matches, merges their results, and —
// if NO language/framework adapter matched — records an honest known-unknown
// (the generic fallback degrades gracefully rather than pretending understanding).

import type {
  DetectedRoute,
  DetectedScript,
  DetectedService,
  Finding,
  KnownUnknown,
} from "../types.js";
import type { Adapter, AdapterContext, Quality } from "./types.js";
import { nodeAdapter } from "./node.js";
import { pythonAdapter } from "./python.js";
import { makeAdapter } from "./make.js";
import { goAdapter, rustAdapter } from "./manifest.js";

/** Language/framework adapters, in priority order. Make is cross-cutting. */
export const ADAPTERS: Adapter[] = [nodeAdapter, pythonAdapter, goAdapter, rustAdapter, makeAdapter];

/** Adapters that establish a project's *type* (vs. the cross-cutting `make`). */
const TYPE_ADAPTERS = new Set(["node", "python", "go", "rust"]);

const QUALITY_RANK: Record<Quality, number> = { inferred: 0, heuristic: 1, parsed: 2, declared: 3 };

export interface MergedAdapterOutput {
  scripts: Finding<DetectedScript>[];
  routes: Finding<DetectedRoute>[];
  services: Finding<DetectedService>[];
  knownUnknowns: KnownUnknown[];
  /** Ids of adapters that applied (for reporting / the repo map). */
  appliedAdapters: string[];
  /** Best command quality achieved by an applicable type-adapter. */
  bestQuality: Quality | null;
  /** Whether any applied adapter's commands are runtime-verifiable. */
  runtimeVerifiable: boolean;
}

/** Run all applicable adapters and merge. Dedupe scripts by (source,name,command). */
export function runAdapters(ctx: AdapterContext): MergedAdapterOutput {
  const scripts: Finding<DetectedScript>[] = [];
  const routes: Finding<DetectedRoute>[] = [];
  const services: Finding<DetectedService>[] = [];
  const knownUnknowns: KnownUnknown[] = [];
  const appliedAdapters: string[] = [];
  let bestQuality: Quality | null = null;
  let runtimeVerifiable = false;
  let matchedType = false;

  const seenScript = new Set<string>();
  const seenRoute = new Set<string>();
  const seenService = new Set<string>();

  for (const adapter of ADAPTERS) {
    let applies = false;
    try {
      applies = adapter.appliesTo(ctx);
    } catch {
      applies = false;
    }
    if (!applies) continue;
    appliedAdapters.push(adapter.id);
    if (TYPE_ADAPTERS.has(adapter.id)) matchedType = true;

    const r = adapter.detect(ctx);
    if (TYPE_ADAPTERS.has(adapter.id)) {
      if (bestQuality === null || QUALITY_RANK[r.quality] > QUALITY_RANK[bestQuality]) bestQuality = r.quality;
    }
    if (r.runtimeVerifiable) runtimeVerifiable = true;

    for (const s of r.scripts) {
      const k = `${s.value.source}::${s.value.name}::${s.value.command}`;
      if (!seenScript.has(k)) { seenScript.add(k); scripts.push(s); }
    }
    for (const rt of r.routes) {
      const k = `${rt.value.method} ${rt.value.pathPattern} ${rt.value.locator}`;
      if (!seenRoute.has(k)) { seenRoute.add(k); routes.push(rt); }
    }
    for (const sv of r.services) {
      const k = sv.value.name;
      if (!seenService.has(k)) { seenService.add(k); services.push(sv); }
    }
    knownUnknowns.push(...r.knownUnknowns);
  }

  // Generic fallback: no language/framework adapter recognized the repo.
  if (!matchedType) {
    knownUnknowns.push({
      id: "generic:unrecognized-project-type",
      kind: "other",
      title: "unrecognized project type",
      detail:
        "No language/framework adapter matched (no package.json, pyproject/requirements, go.mod, or Cargo.toml). " +
        "OpenClaw inventoried files but cannot derive commands, routes, or services for this project type. " +
        "Files, env, docker, and docs detection still apply.",
      evidence: [],
      status: "open",
      confidenceImpact: "high",
    });
  }

  return { scripts, routes, services, knownUnknowns, appliedAdapters, bestQuality, runtimeVerifiable };
}
