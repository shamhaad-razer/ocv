// Generated Internal Tools (11-internal-tool-generator.md, prompt 46). Pure.
//
// Turns a ToolProposal (prompt 45) + the stored intelligence into a SAFE,
// DECLARATIVE `GeneratedToolSpec` — never generated code. The spec is a list of
// closed-kind sections (table/list/key-value/mermaid/note/actions) whose data is
// RESOLVED here, at generation time, from the index. So:
//   - the UI renders pure data through a fixed widget set (S4 safety),
//   - rendering touches neither the target nor the index again,
//   - actions are DESCRIBED + safety-classified, never auto-run.
//
// Tools belong to the OpenClaw HOST (stored host-side by the caller), are
// read-only by default, and carry freshness/confidence/known-unknowns. If the
// intel looks stale, the spec is flagged so the UI warns.

import { buildCommandBook } from "./onboarding.js";
import { flowForRepo } from "./flowmap.js";
import { classifyCommand } from "./verify.js";
import type {
  Confidence,
  FreshnessStatus,
  GeneratedToolSpec,
  KnownUnknown,
  SourceRef,
  ToolAction,
  ToolProposal,
  ToolSection,
  ToolType,
  WorkspaceIntel,
} from "./types.js";

export interface ToolGenOptions {
  generatedAt: number;
  scanVersion: string;
  /** The stored index the tool reads from. */
  ws: WorkspaceIntel;
  /** The proposal (prompt 45) driving generation. */
  proposal: ToolProposal;
  /** Overall freshness verdict for the target (from the dashboard/registry). */
  freshness: FreshnessStatus | "unknown";
  /** Base commit of the index (for traceability). */
  scanBaseCommit?: string | null;
}

/** The tool types this MVP can generate (≥3 required; we ship 6). */
export const GENERATABLE: ToolType[] = [
  "command-dashboard",
  "route-explorer",
  "api-explorer",
  "env-var-explorer",
  "deployment-explorer",
  "flow-explorer",
  "known-unknowns-tracker",
];

export function isGeneratable(type: ToolType): boolean {
  return GENERATABLE.includes(type);
}

/**
 * Generator version — bump when the spec shape or a builder changes materially, so
 * stale detection can invalidate older specs (prompt 47 req #1). Independent of
 * SCAN_VERSION (which tracks the index format).
 */
export const GENERATOR_VERSION = "1.0.0";

/**
 * Which project-intelligence ARTIFACT kinds each tool's data derives from
 * (freshness.ts ArtifactKind values). Drift the freshness engine reports in any of
 * these → the tool is stale (prompt 47 req #2/#3).
 */
const TOOL_ARTIFACT_DEPS: Record<ToolType, string[]> = {
  "command-dashboard": ["command-book"],
  "route-explorer": ["repo-map", "explanation-cache"],
  "api-explorer": ["repo-map", "explanation-cache"],
  "service-map-viewer": ["repo-map"],
  "deployment-explorer": ["deployment-explanation"],
  "env-var-explorer": ["onboarding-docs", "deployment-explanation"],
  "flow-explorer": ["known-flows"],
  "change-impact-viewer": ["confidence-report"],
  "test-runner-guide": ["command-book"],
  "service-health-dashboard": ["deployment-explanation"],
  "known-unknowns-tracker": ["repo-map"],
  "setup-checker": ["command-book", "onboarding-docs"],
  "repo-mirroring-panel": ["repo-map", "command-book"],
};

/** Map a tool type to which index finding-arrays its data files come from. */
function sourceFilesForType(type: ToolType, ws: WorkspaceIntel): { repo: string; ref: string; hash: string }[] {
  const out: { repo: string; ref: string; hash: string }[] = [];
  const seen = new Set<string>();
  const add = (repo: string, fhs: { ref: string; hash: string }[]) => {
    for (const fh of fhs) {
      const k = `${repo}:${fh.ref}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ repo, ref: fh.ref, hash: fh.hash });
    }
  };
  for (const repo of ws.repos) {
    switch (type) {
      case "command-dashboard":
      case "test-runner-guide":
      case "setup-checker":
        add(repo.name, repo.packageFiles.flatMap((f) => f.grounding.fileHashes));
        add(repo.name, repo.scripts.flatMap((f) => f.grounding.fileHashes));
        break;
      case "route-explorer":
      case "api-explorer":
        add(repo.name, repo.routes.flatMap((f) => f.grounding.fileHashes));
        break;
      case "env-var-explorer":
        add(repo.name, repo.envVars.flatMap((f) => f.grounding.fileHashes));
        add(repo.name, repo.envFiles.flatMap((f) => f.grounding.fileHashes));
        break;
      case "deployment-explorer":
      case "service-map-viewer":
      case "service-health-dashboard":
        add(repo.name, repo.deployFiles.flatMap((f) => f.grounding.fileHashes));
        add(repo.name, repo.services.flatMap((f) => f.grounding.fileHashes));
        break;
      case "flow-explorer":
        // flow rests on each repo's manifest (package deps) + env/port signals
        add(repo.name, repo.packageFiles.flatMap((f) => f.grounding.fileHashes));
        add(repo.name, repo.envVars.flatMap((f) => f.grounding.fileHashes));
        break;
      default:
        // known-unknowns/change-impact: repo-level grounding
        add(repo.name, repo.grounding.fileHashes);
    }
  }
  return out.slice(0, 60);
}

/**
 * A stable signature of the PROPOSAL's material content (type + confidence +
 * data sources + the counts embedded in its title/description). If a re-detected
 * proposal's signature differs, the tool changed materially → stale.
 */
export function proposalSignature(p: ToolProposal): string {
  const counts = (p.title + " " + p.description).match(/\((\d+)\)|\b(\d+)\b/g)?.join(",") ?? "";
  const basis = [p.type, p.confidence, p.requiredDataSources.slice().sort().join("|"), counts].join("::");
  // tiny non-crypto hash (djb2) — deterministic + dependency-free
  let h = 5381;
  for (let i = 0; i < basis.length; i++) h = ((h << 5) + h + basis.charCodeAt(i)) >>> 0;
  return `sig_${h.toString(16)}`;
}

const STALE: FreshnessStatus[] = ["potentially-stale", "known-stale"];

/**
 * Generate a safe spec for a proposal. Returns null if the type isn't supported
 * yet (caller reports it). Pure: reads only the passed index.
 */
export function generateTool(opts: ToolGenOptions): GeneratedToolSpec | null {
  const p = opts.proposal;
  const ws = opts.ws;
  if (!isGeneratable(p.type)) return null;

  const sections: ToolSection[] = [];
  const actions: ToolAction[] = [];
  const sources: SourceRef[] = [];

  switch (p.type) {
    case "command-dashboard":
      buildCommandDashboard(ws, sections, actions, sources);
      break;
    case "route-explorer":
    case "api-explorer":
      buildRouteExplorer(ws, sections, sources);
      break;
    case "env-var-explorer":
      buildEnvExplorer(ws, sections, sources);
      break;
    case "deployment-explorer":
      buildDeploymentExplorer(ws, sections, sources);
      break;
    case "flow-explorer":
      buildFlowExplorer(ws, sections, sources);
      break;
    case "known-unknowns-tracker":
      buildKnownUnknownsTracker(ws, sections, sources);
      break;
    default:
      return null;
  }

  // Every tool opens with a provenance note (what + how fresh + how sure).
  const stale = typeof opts.freshness === "string" && (STALE as string[]).includes(opts.freshness);
  sections.unshift({
    id: "about",
    kind: "key-value",
    title: "About this tool",
    caption: "Generated by OpenClaw from stored project intelligence — read-only.",
    pairs: [
      { key: "tool type", value: p.type },
      { key: "confidence", value: p.confidence },
      { key: "freshness", value: String(opts.freshness) },
      { key: "data sources", value: p.requiredDataSources.join(", ") },
      { key: "why useful", value: p.whyUseful },
    ],
  });
  if (stale) {
    sections.unshift({
      id: "stale-warning",
      kind: "note",
      title: "⚠ Possibly stale",
      severity: "warn",
      text: `This tool was built from project intelligence that looks ${opts.freshness}. The target may have changed since the last scan — re-scan (\`scan --target\`) before relying on details.`,
    });
  }

  // safety rollup from the actions
  const order = { "safe-auto": 0, "confirm-required": 1, blocked: 2 } as const;
  let safety: ToolAction["safety"] = "safe-auto";
  for (const a of actions) if (order[a.safety] > order[safety]) safety = a.safety;
  const requiresConfirmation = actions.some((a) => a.requiresConfirmation);

  return {
    version: 1,
    id: `gtool:${p.type}:${p.targetProjectId}`,
    targetProjectId: p.targetProjectId,
    targetPath: ws.targetPath ?? ws.rootPath,
    title: p.title,
    description: p.description,
    type: p.type,
    interactivity: p.interactivity,
    sections,
    actions,
    dataSources: p.requiredDataSources,
    sources: dedupeRefs([...p.evidence, ...sources]),
    dependsOnArtifacts: TOOL_ARTIFACT_DEPS[p.type] ?? ["repo-map"],
    sourceFileHashes: sourceFilesForType(p.type, ws),
    proposalSignature: proposalSignature(p),
    confidence: p.confidence,
    freshness: opts.freshness,
    stale,
    staleWarning: stale ? `Intelligence is ${opts.freshness}; re-scan before relying on details.` : "",
    knownUnknowns: p.knownUnknowns,
    safety,
    requiresConfirmation,
    generatedAt: opts.generatedAt,
    scanVersion: opts.scanVersion,
    scanBaseCommit: opts.scanBaseCommit ?? null,
    generatorVersion: GENERATOR_VERSION,
  };
}

// --------------------------------------------------------------------------
// per-type builders — resolve real data from the index into safe sections
// --------------------------------------------------------------------------

function buildCommandDashboard(ws: WorkspaceIntel, sections: ToolSection[], actions: ToolAction[], sources: SourceRef[]): void {
  const book = buildCommandBook(ws);
  const rows = book.entries.map((e) => [e.repo, e.category, e.command, e.safety]);
  sections.push({
    id: "commands",
    kind: "table",
    title: `Commands (${book.entries.length})`,
    caption: "Detected commands with their safety class. Running is gated by the safety policy.",
    columns: ["repo", "category", "command", "safety"],
    rows,
  });
  // Offer safe/confirm-gated run actions ONLY for test/lint/build (never deploy/install).
  const runnable = book.entries.filter((e) => ["test", "lint", "build"].includes(e.category));
  for (const e of runnable.slice(0, 8)) {
    const cls = classifyCommand(e.command);
    sources.push({ kind: "file", ref: e.sourceFile, locator: e.sourceLocator });
    actions.push({
      id: `run:${e.repo}:${e.name}`,
      label: `Run ${e.category}: ${e.name}`,
      repo: e.repo,
      command: e.command,
      safety: cls.classification,
      safetyReason: cls.reason,
      requiresConfirmation: cls.classification !== "safe-auto",
    });
  }
  if (actions.length) {
    sections.push({
      id: "run-actions",
      kind: "actions",
      title: "Run a check (safety-gated)",
      caption: "Each action is classified; confirm-required actions need explicit approval. Destructive/installing/deploy commands are never offered as actions.",
      actionIds: actions.map((a) => a.id),
    });
  }
}

function buildRouteExplorer(ws: WorkspaceIntel, sections: ToolSection[], sources: SourceRef[]): void {
  const rows: string[][] = [];
  for (const repo of ws.repos) {
    for (const r of repo.routes) {
      rows.push([repo.name, r.value.method, r.value.pathPattern, r.value.locator]);
      sources.push({ kind: "file", ref: r.value.locator });
    }
  }
  rows.sort((a, b) => a[2].localeCompare(b[2]));
  sections.push({
    id: "routes",
    kind: "table",
    title: `Routes (${rows.length})`,
    caption: "HTTP/WS endpoints detected by adapter heuristics (regex — may miss dynamic routes).",
    columns: ["repo", "method", "path", "source"],
    rows,
  });
  // by-method summary
  const byMethod = new Map<string, number>();
  for (const r of rows) byMethod.set(r[1], (byMethod.get(r[1]) ?? 0) + 1);
  sections.push({
    id: "by-method",
    kind: "list",
    title: "By method",
    items: [...byMethod.entries()].map(([m, n]) => `${m}: ${n}`),
  });
}

function buildEnvExplorer(ws: WorkspaceIntel, sections: ToolSection[], sources: SourceRef[]): void {
  // names ONLY — values are never read (S6).
  const rows: string[][] = [];
  const seen = new Set<string>();
  for (const repo of ws.repos) {
    for (const e of repo.envVars) {
      const key = `${repo.name}:${e.value.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push([repo.name, e.value.name, e.value.source]);
      sources.push({ kind: "file", ref: e.value.source, locator: e.value.name });
    }
  }
  rows.sort((a, b) => a[1].localeCompare(b[1]));
  sections.push({
    id: "env-vars",
    kind: "table",
    title: `Environment variables (${rows.length})`,
    caption: "Variable NAMES only — OpenClaw never reads or stores values (S6).",
    columns: ["repo", "name", "declared in"],
    rows,
  });
  sections.push({
    id: "env-note",
    kind: "note",
    title: "Set these before running",
    text: "Copy the relevant .env example to .env and fill in values. Values are your responsibility; OpenClaw only lists which names the project references.",
  });
}

function buildDeploymentExplorer(ws: WorkspaceIntel, sections: ToolSection[], sources: SourceRef[]): void {
  const rows: string[][] = [];
  for (const repo of ws.repos) {
    for (const f of repo.deployFiles) {
      rows.push([repo.name, f.value]);
      sources.push({ kind: "file", ref: f.value });
    }
  }
  sections.push({
    id: "deploy-files",
    kind: "table",
    title: `Deployment signals (${rows.length})`,
    caption: "Declared deployment config detected in the scan.",
    columns: ["repo", "file"],
    rows,
  });
  sections.push({
    id: "deploy-note",
    kind: "note",
    title: "Config only — production topology unknown",
    severity: "warn",
    text: "This reads declared config. The live production deployment (replicas, cluster, scaling, secrets) is NOT observable and must not be assumed. Run the deployment report for the full inferred picture.",
  });
}

function buildFlowExplorer(ws: WorkspaceIntel, sections: ToolSection[], sources: SourceRef[]): void {
  const flow = ws.flowMap;
  if (!flow || flow.edges.length === 0) {
    sections.push({ id: "no-flow", kind: "note", title: "No cross-repo edges", severity: "warn", text: "No inferred cross-repo relationships were found. A flow explorer needs a multi-repo workspace with shared packages/ports/env." });
    return;
  }
  const rows = flow.edges.map((e) => [e.from, e.to, e.kind, e.label, e.confidence]);
  for (const e of flow.edges) for (const ev of e.evidence) sources.push(ev);
  sections.push({
    id: "edges",
    kind: "table",
    title: `Cross-repo edges (${flow.edges.length})`,
    caption: "INFERRED from shared packages/ports/env — hints, not a proven call graph.",
    columns: ["from", "to", "kind", "label", "confidence"],
    rows,
  });
  // a Mermaid diagram (reuse the flow map's shape)
  const id = (s: string) => s.replace(/[^A-Za-z0-9_]/g, "_");
  const repoNodes = flow.nodes.filter((n) => n.kind === "repo");
  const mlines = ["flowchart LR"];
  for (const n of repoNodes) mlines.push(`  ${id(n.repo)}["${n.repo}"]`);
  for (const e of flow.edges) {
    const style = e.confidence === "high" ? "-->" : e.confidence === "medium" ? "-.->" : "-..->";
    mlines.push(`  ${id(e.from)} ${style}|"${e.kind}"| ${id(e.to)}`);
  }
  sections.push({ id: "diagram", kind: "mermaid", title: "Topology", caption: "solid=high · dashed=medium · dotted=low (inferred)", mermaid: mlines.join("\n") });
}

function buildKnownUnknownsTracker(ws: WorkspaceIntel, sections: ToolSection[], _sources: SourceRef[]): void {
  const all: { repo: string; u: KnownUnknown }[] = [];
  for (const repo of ws.repos) for (const u of repo.knownUnknowns) all.push({ repo: repo.name, u });
  for (const u of ws.knownUnknowns) all.push({ repo: "workspace", u });
  const rank: Record<Confidence, number> = { high: 0, medium: 1, low: 2 };
  all.sort((a, b) => rank[a.u.confidenceImpact] - rank[b.u.confidenceImpact]);
  sections.push({
    id: "unknowns",
    kind: "table",
    title: `Known unknowns (${all.length})`,
    caption: "What OpenClaw does NOT yet know about this project, by impact — so nothing is silently assumed.",
    columns: ["impact", "scope", "title", "detail"],
    rows: all.map(({ repo, u }) => [u.confidenceImpact, repo, u.title, u.detail]),
  });
  if (all.length === 0) {
    sections.push({ id: "none", kind: "note", title: "No open known-unknowns", text: "The scan recorded no open gaps. That's not a guarantee of completeness — re-scan after changes." });
  }
}

function dedupeRefs(refs: SourceRef[]): SourceRef[] {
  const seen = new Set<string>();
  const out: SourceRef[] = [];
  for (const r of refs) {
    const k = `${r.kind}:${r.ref}:${r.locator ?? ""}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out.slice(0, 30);
}
