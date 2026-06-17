// Tool Opportunity Detector (11-internal-tool-generator.md, prompt 45). READ-ONLY.
//
// Inspects the STORED project intelligence for a registered target and PROPOSES
// project-specific internal tools worth building (API explorer, command dashboard,
// flow explorer, …). It is a *detector*, not the generator: it emits grounded
// proposals — never code, never anything written into or run against the target.
//
// Principles (carried from the design + the honesty spine):
//   - Every proposal is a VIEW over data that ALREADY EXISTS (the dashboard
//     aggregate + the scanned index). No proposal invents new intelligence.
//   - PROJECT-SPECIFIC: rules fire on this project's actual signals (route count,
//     deploy files, command count, multi-repo edges, unknown env vars, …).
//   - NO OVERCLAIM: thin evidence → low/medium confidence. If there's too little
//     to build anything useful, propose a known-unknowns tracker instead.
//   - Each proposal carries evidence + confidence + freshness + known-unknowns +
//     a safety class, so the UI/user can judge it.

import type {
  Confidence,
  FreshnessStatus,
  KnownUnknown,
  SourceRef,
  TargetDashboard,
  ToolInteractivity,
  ToolOpportunityReport,
  ToolProposal,
  ToolType,
  WorkspaceIntel,
} from "./types.js";

export interface ToolDetectOptions {
  generatedAt: number;
  scanVersion: string;
  /** The dashboard aggregate (the signal source). */
  dashboard: TargetDashboard;
  /** The stored index, for finer signals (flow edges, raw known-unknowns). */
  ws: WorkspaceIntel | null;
}

const CONF_RANK: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };
function bestConf(a: Confidence, b: Confidence): Confidence {
  return CONF_RANK[a] >= CONF_RANK[b] ? a : b;
}

/** A rule's accumulated signal across all repos. */
interface Totals {
  routes: number;
  services: number;
  commands: number;
  envVars: number;
  deployFiles: number;
  tests: number; // # repos with a test command
  symbols: number;
  knownUnknowns: number;
  undocumentedEnv: number; // env-var known-unknowns
}

function sumTotals(d: TargetDashboard, ws: WorkspaceIntel | null): Totals {
  const routes = d.repos.reduce((n, r) => n + r.routes, 0);
  const services = d.repos.reduce((n, r) => n + r.services, 0);
  const envVars = d.repos.reduce((n, r) => n + r.envVars, 0);
  const deployFiles = d.repos.reduce((n, r) => n + r.deployFiles, 0);
  const symbols = d.repos.reduce((n, r) => n + r.symbols, 0);
  const commands = d.commands.total;
  // # of repos that have a `test` command (test-runner signal)
  const tests = (ws?.repos ?? []).filter((r) => r.scripts.some((s) => s.value.category === "test")).length;
  const knownUnknowns = d.knownUnknowns.total;
  const undocumentedEnv = (ws?.repos ?? []).reduce(
    (n, r) => n + r.knownUnknowns.filter((u) => u.kind === "undocumented-env-var" || u.kind === "missing-env-example").length,
    0,
  );
  return { routes, services, commands, envVars, deployFiles, tests, symbols, knownUnknowns, undocumentedEnv };
}

/** Cross-repo edges from the flow map (multi-repo flow signal). */
function flowEdgeCount(ws: WorkspaceIntel | null): number {
  return ws?.flowMap?.edges.length ?? 0;
}

function mkUnknown(id: string, title: string, detail: string, impact: Confidence): KnownUnknown {
  return { id, kind: "other", title, detail, evidence: [], status: "open", confidenceImpact: impact };
}

/** Build a proposal with sane defaults; callers override what matters. */
function propose(
  d: TargetDashboard,
  type: ToolType,
  fields: {
    title: string;
    description: string;
    whyUseful: string;
    userProblem: string;
    requiredDataSources: string[];
    evidence: SourceRef[];
    confidence: Confidence;
    knownUnknowns?: KnownUnknown[];
    safety?: ToolProposal["safety"];
    requiresRuntimeChecks?: boolean;
    requiresConfirmation?: boolean;
    interactivity: ToolInteractivity;
    score: number;
  },
): ToolProposal {
  return {
    id: `tool:${type}:${d.project.id}`,
    title: fields.title,
    description: fields.description,
    targetProjectId: d.project.id,
    type,
    whyUseful: fields.whyUseful,
    userProblem: fields.userProblem,
    requiredDataSources: fields.requiredDataSources,
    evidence: fields.evidence,
    confidence: fields.confidence,
    freshness: d.freshness,
    knownUnknowns: fields.knownUnknowns ?? [],
    safety: fields.safety ?? "safe-auto",
    requiresRuntimeChecks: fields.requiresRuntimeChecks ?? false,
    requiresConfirmation: fields.requiresConfirmation ?? false,
    interactivity: fields.interactivity,
    score: fields.score,
  };
}

/**
 * Detect tool opportunities for a target. Pure: reads the dashboard + index only.
 */
export function detectToolOpportunities(opts: ToolDetectOptions): ToolOpportunityReport {
  const d = opts.dashboard;
  const ws = opts.ws;
  const now = opts.generatedAt;
  const proposals: ToolProposal[] = [];
  const t = sumTotals(d, ws);
  const edges = flowEdgeCount(ws);
  const ev = (kind: SourceRef["kind"], ref: string, locator?: string): SourceRef => ({ kind, ref, locator });

  // confidence from a count: more evidence → higher, but never overclaim.
  const confFromCount = (n: number, mid: number, high: number): Confidence =>
    n >= high ? "high" : n >= mid ? "medium" : "low";

  if (!d.scanned) {
    // Nothing indexed — the only honest proposal is a known-unknowns tracker.
    proposals.push(knownUnknownsTracker(d, now, t, /*onlyOption*/ true));
    return finalize(d, ws, now, opts.scanVersion, proposals);
  }

  // --- routes / APIs → API + route explorer (req #5 example) ---
  if (t.routes >= 1) {
    const conf = confFromCount(t.routes, 5, 15);
    proposals.push(
      propose(d, t.routes >= 5 ? "api-explorer" : "route-explorer", {
        title: t.routes >= 5 ? "API Explorer" : "Route Explorer",
        description: `Browse the ${t.routes} detected HTTP/WS route(s) across ${d.repos.length} repo(s), grouped by service, with their source locations.`,
        whyUseful: "The project exposes endpoints; a route view lets a developer see the API surface at a glance instead of grepping handlers.",
        userProblem: "Understanding what endpoints exist and where they're implemented when onboarding or debugging.",
        requiredDataSources: ["routes", "services", "repo map"],
        evidence: [ev("intel-entity", `routes:${t.routes}`), ...routeRefs(ws)],
        confidence: conf,
        knownUnknowns: [mkUnknown("tool:routes-heuristic", "routes are regex-detected", "Routes come from adapter regex heuristics, not a parser — some may be missed or mislabeled.", "medium")],
        interactivity: "interactive",
        score: 40 + Math.min(t.routes, 30),
      }),
    );
  }

  // --- multiple services → service map viewer ---
  if (t.services >= 2 || (t.services >= 1 && d.repos.length >= 2)) {
    proposals.push(
      propose(d, "service-map-viewer", {
        title: "Service Map Viewer",
        description: `Visualize the ${t.services} detected service boundary(ies) and how they relate across the workspace.`,
        whyUseful: "Multiple services exist; a map clarifies boundaries, ports, and ownership.",
        userProblem: "Seeing the system's service topology without reading every config.",
        requiredDataSources: ["services", "repo map", "flow map"],
        evidence: [ev("intel-entity", `services:${t.services}`)],
        confidence: confFromCount(t.services, 2, 4),
        interactivity: "interactive",
        score: 32 + Math.min(t.services, 10),
      }),
    );
  }

  // --- commands → command dashboard (req #5 example) ---
  if (t.commands >= 3) {
    const blockedNote = mkUnknown("tool:command-safety", "commands carry a safety class", "Run actions in this tool must honor the command safety classifier (destructive/installing/deploy are blocked).", "low");
    proposals.push(
      propose(d, "command-dashboard", {
        title: "Command Dashboard",
        description: `One place for the ${t.commands} detected command(s) (${d.commands.byCategory.map((c) => `${c.category}:${c.count}`).join(", ")}), each with its safety class.`,
        whyUseful: "The project has a rich command set; a dashboard surfaces how to install/test/build/run without digging through manifests.",
        userProblem: "Re-discovering the right command to run for a task.",
        requiredDataSources: ["command book", "local environment"],
        evidence: [ev("intel-entity", `commands:${t.commands}`), ...commandRefs(d)],
        confidence: confFromCount(t.commands, 4, 8),
        safety: "confirm-required", // running a command always needs gating
        requiresRuntimeChecks: true,
        requiresConfirmation: true,
        knownUnknowns: [blockedNote],
        interactivity: "runtime-assisted",
        score: 45 + Math.min(t.commands, 20),
      }),
    );
  }

  // --- test commands → test runner guide ---
  if (t.tests >= 1) {
    proposals.push(
      propose(d, "test-runner-guide", {
        title: "Test Runner Guide",
        description: `Guide to running the test suite(s) in ${t.tests} repo(s), with the machine-correct command and safety class.`,
        whyUseful: "Test commands are detected; a guided runner removes the guesswork before pushing.",
        userProblem: "Knowing how to run (and trust) the tests for an unfamiliar repo.",
        requiredDataSources: ["command book", "local environment", "change-confidence"],
        evidence: [ev("intel-entity", `test-commands:${t.tests}`)],
        confidence: "medium",
        safety: "confirm-required",
        requiresRuntimeChecks: true,
        requiresConfirmation: true,
        interactivity: "runtime-assisted",
        score: 30 + t.tests,
      }),
    );
  }

  // --- deployment signals → deployment explorer (+ health if services) ---
  if (d.deployment.hasSignals) {
    proposals.push(
      propose(d, "deployment-explorer", {
        title: "Deployment Explorer",
        description: `Explore the ${d.deployment.signalFiles.length} detected deployment signal(s) (${d.deployment.signalFiles.slice(0, 4).join(", ")}…) — declared config only.`,
        whyUseful: "The project ships deployment config; an explorer explains how it's built/shipped without reading every file.",
        userProblem: "Understanding how the system deploys (or might) when you didn't write the pipeline.",
        requiredDataSources: ["deployment report", "services", "env vars"],
        evidence: d.deployment.signalFiles.slice(0, 6).map((f) => ev("file", f)),
        confidence: confFromCount(d.deployment.signalFiles.length, 2, 4),
        knownUnknowns: [mkUnknown("tool:deploy-config-only", "config ≠ live deployment", "Reads declared config only; the live production topology is not observable.", "medium")],
        interactivity: "interactive",
        score: 42 + Math.min(d.deployment.signalFiles.length, 12),
      }),
    );
    if (t.services >= 1) {
      proposals.push(
        propose(d, "service-health-dashboard", {
          title: "Local Service Health Dashboard",
          description: `Poll the ${t.services} detected service(s) for liveness/readiness when run locally.`,
          whyUseful: "Services + deployment config exist; a health view confirms what's actually up locally.",
          userProblem: "Knowing whether the local services are running and healthy.",
          requiredDataSources: ["services", "deployment report", "local environment"],
          evidence: [ev("intel-entity", `services:${t.services}`)],
          confidence: "low", // needs running services to be useful
          safety: "confirm-required",
          requiresRuntimeChecks: true,
          requiresConfirmation: true,
          knownUnknowns: [mkUnknown("tool:health-needs-running", "needs running services", "Health polling only works against locally-running services; ports are inferred.", "medium")],
          interactivity: "runtime-assisted",
          score: 20 + Math.min(t.services, 8),
        }),
      );
    }
  }

  // --- env vars → env var explorer + setup checker (req #5 example) ---
  if (t.envVars >= 1) {
    proposals.push(
      propose(d, "env-var-explorer", {
        title: "Env Var Explorer",
        description: `List the ${t.envVars} referenced environment variable name(s) (names only — values are never read) and where each is used.`,
        whyUseful: "The project references configuration via env; an explorer shows what must be set, without exposing secrets.",
        userProblem: "Figuring out which env vars to configure before the project will run.",
        requiredDataSources: ["env vars", "deployment report"],
        evidence: [ev("intel-entity", `env-vars:${t.envVars}`)],
        confidence: confFromCount(t.envVars, 3, 8),
        interactivity: "interactive",
        score: 28 + Math.min(t.envVars, 15),
      }),
    );
  }
  // setup checker fires when env is documented-incomplete OR tools are missing
  const toolsMissing = d.environment?.toolsMissing?.length ?? 0;
  if (t.undocumentedEnv >= 1 || toolsMissing >= 1) {
    proposals.push(
      propose(d, "setup-checker", {
        title: "Setup Checker",
        description: `Check this project's setup against your machine: ${t.undocumentedEnv} undocumented-env gap(s)${toolsMissing ? `, ${toolsMissing} missing tool(s)` : ""}.`,
        whyUseful: "There are setup gaps (undocumented env and/or missing local tools); a checker tells you what to fix before running.",
        userProblem: "Hitting cryptic failures because the environment isn't set up the way the project expects.",
        requiredDataSources: ["env vars", "known unknowns", "local environment", "command book"],
        evidence: [ev("intel-entity", `undocumented-env:${t.undocumentedEnv}`), ev("intel-entity", `missing-tools:${toolsMissing}`)],
        confidence: t.undocumentedEnv + toolsMissing >= 3 ? "medium" : "low",
        knownUnknowns: [mkUnknown("tool:setup-partial", "setup gaps are heuristic", "Detected from .env examples + tool probes; some required setup may be undocumented entirely.", "medium")],
        interactivity: "interactive",
        score: 34 + Math.min(t.undocumentedEnv + toolsMissing, 12),
      }),
    );
  }

  // --- multi-repo with inferred edges → flow explorer (req #5 example) ---
  if (d.project.repoType === "multi-repo" && edges >= 1) {
    proposals.push(
      propose(d, "flow-explorer", {
        title: "Multi-Repo Flow Explorer",
        description: `Step through the ${edges} inferred cross-repo link(s) among ${d.repos.length} repos (shared package/port/env — inferred, not proven).`,
        whyUseful: "It's a multi-repo system with inferred cross-repo relationships; a flow view makes the wiring navigable.",
        userProblem: "Understanding how the repos connect at runtime when no one diagrammed it.",
        requiredDataSources: ["flow map", "services", "env vars"],
        evidence: [ev("intel-entity", `flow-edges:${edges}`)],
        confidence: confFromCount(edges, 2, 4),
        knownUnknowns: [mkUnknown("tool:flow-inferred", "edges are inferred", "Cross-repo edges are inferred from shared packages/ports/env — not a verified call graph.", "medium")],
        interactivity: "interactive",
        score: 38 + Math.min(edges, 10),
      }),
    );
  }

  // --- always useful once scanned: change impact viewer (git-driven) ---
  proposals.push(
    propose(d, "change-impact-viewer", {
      title: "Change Impact Viewer",
      description: "View what your uncommitted changes touch (files → entities/symbols/references) and which checks to run before pushing.",
      whyUseful: "The index links files to entities; a change view turns `git status` into a pre-push confidence panel.",
      userProblem: "Not knowing what a change might affect or what to test before pushing.",
      requiredDataSources: ["change-confidence report", "symbols", "command book"],
      evidence: [ev("intel-entity", "change-confidence")],
      confidence: t.symbols >= 1 ? "medium" : "low",
      knownUnknowns: [mkUnknown("tool:impact-no-callgraph", "no call graph", "Impact is text-matched (file→entity/reference), not a proven call graph.", "medium")],
      interactivity: "runtime-assisted",
      requiresRuntimeChecks: true,
      score: 26 + Math.min(t.symbols, 10),
    }),
  );

  // --- repo mirroring panel (only meaningful with >1 registered project) ---
  // We can't see the registry here, but multi-repo workspaces are a strong signal.
  if (d.project.repoType === "multi-repo") {
    proposals.push(
      propose(d, "repo-mirroring-panel", {
        title: "Repo Mirroring Panel",
        description: "Compare this project's repos (or another registered project) and propose safe alignment of config/scripts/CI — propose-only.",
        whyUseful: "Multi-repo workspaces drift; a mirroring panel surfaces safe-to-align gaps without copying blindly.",
        userProblem: "Keeping sibling repos' conventions/config consistent without re-explaining intent each time.",
        requiredDataSources: ["repo map", "command book", "deployment report"],
        evidence: [ev("intel-entity", `repos:${d.repos.length}`)],
        confidence: "low",
        interactivity: "interactive",
        score: 14,
      }),
    );
  }

  // --- known-unknowns tracker: always offered (and the headline if evidence thin) ---
  proposals.push(knownUnknownsTracker(d, now, t, /*onlyOption*/ proposals.length === 0));

  return finalize(d, ws, now, opts.scanVersion, proposals);
}

function knownUnknownsTracker(d: TargetDashboard, _now: number, t: Totals, onlyOption: boolean): ToolProposal {
  return propose(d, "known-unknowns-tracker", {
    title: "Known-Unknowns Tracker",
    description: onlyOption
      ? `Track what OpenClaw does NOT yet know about this project (${d.knownUnknowns.total} open item(s)). ${d.scanned ? "Evidence is thin — scan more / re-scan to unlock richer tools." : "Run a scan first to unlock project-specific tools."}`
      : `Track and triage the ${d.knownUnknowns.total} open known-unknown(s) for this project (by impact).`,
    whyUseful: onlyOption
      ? "There isn't enough source-grounded signal yet to build a richer tool honestly — the most useful thing is to make the gaps visible."
      : "Every other tool has blind spots; a tracker keeps the project's uncertainty explicit so nothing is silently assumed.",
    userProblem: "Mistaking absence of information for absence of risk.",
    requiredDataSources: ["known unknowns", "freshness"],
    evidence: [{ kind: "intel-entity", ref: `known-unknowns:${d.knownUnknowns.total}` }],
    confidence: d.knownUnknowns.total >= 1 ? "high" : "medium", // we DO know the unknowns
    interactivity: "static",
    score: onlyOption ? 100 : 10,
  });
}

/** Source refs for a few detected routes (evidence). */
function routeRefs(ws: WorkspaceIntel | null): SourceRef[] {
  const out: SourceRef[] = [];
  for (const r of ws?.repos ?? []) {
    for (const route of r.routes.slice(0, 3)) out.push({ kind: "file", ref: route.value.locator });
    if (out.length >= 6) break;
  }
  return out;
}
/** Source refs for a few detected commands (evidence). */
function commandRefs(d: TargetDashboard): SourceRef[] {
  return d.commands.sample.slice(0, 4).map((c) => ({ kind: "file" as const, ref: `${c.repo}: ${c.command}` }));
}

function finalize(
  d: TargetDashboard,
  _ws: WorkspaceIntel | null,
  now: number,
  scanVersion: string,
  proposals: ToolProposal[],
): ToolOpportunityReport {
  // rank highest-value first
  proposals.sort((a, b) => b.score - a.score);
  // overall confidence = the best-supported proposal's
  let confidence: Confidence = "low";
  for (const p of proposals) confidence = bestConf(confidence, p.confidence);

  const knownUnknowns: KnownUnknown[] = [
    mkUnknown(
      "tooldetect:proposals-not-generated",
      "proposals are suggestions, not built tools",
      "This detects WHICH tools would help; it does not generate them. Each proposal renders existing intelligence and must be built behind the UI render surface.",
      "low",
    ),
  ];
  if (!d.scanned) {
    knownUnknowns.push(mkUnknown("tooldetect:not-scanned", "target not scanned", "No stored scan to analyze — only a known-unknowns tracker can be proposed until you scan.", "high"));
  }

  const topTypes = proposals.slice(0, 4).map((p) => p.title).join(", ");
  const summary = d.scanned
    ? `${proposals.length} project-specific tool(s) proposed for \`${d.project.displayName}\` (top: ${topTypes}). ` +
      `Overall confidence ${confidence}, freshness ${d.freshness}. These are grounded suggestions over EXISTING intelligence — nothing is generated or run against the target.`
    : `\`${d.project.displayName}\` has not been scanned, so only a known-unknowns tracker is proposed. Run a scan to unlock project-specific tools.`;

  return {
    version: 1,
    generatedAt: now,
    scanVersion,
    targetProjectId: d.project.id,
    targetPath: d.project.targetPath,
    scanned: d.scanned,
    proposals,
    confidence,
    freshness: d.freshness,
    knownUnknowns,
    summary,
  };
}
