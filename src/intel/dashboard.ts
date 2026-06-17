// Target Project Dashboard aggregate (prompt 40). Pure + READ-ONLY.
//
// Assembles ONE compact `TargetDashboard` from data that ALREADY EXISTS on the
// host: the stored project-intelligence index, the registry entry, and the host
// environment profile. It runs nothing (no scan, no probes) and writes nothing —
// it just rolls up what previous scans/reports produced so the UI can show
// overview + repo map + command summary + freshness/confidence/known-unknowns in
// one connected place. Heavy on-demand artifacts (full change/deploy reports) are
// produced by their own commands; the dashboard only PEEKS at deployment signals.
//
// Honest by construction: freshness/confidence/known-unknowns are carried straight
// from the stored grounding — never re-asserted — so uncertainty stays visible.

import { buildCommandBook } from "./onboarding.js";
import type { TargetProject } from "./registry.js";
import type {
  Confidence,
  FreshnessStatus,
  TargetDashboard,
  WorkspaceIntel,
} from "./types.js";

const CONF_RANK: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };
function worse(a: Confidence, b: Confidence): Confidence {
  return CONF_RANK[a] <= CONF_RANK[b] ? a : b;
}

export interface DashboardOptions {
  generatedAt: number;
  /** The registry entry for the target (metadata: id/name/repo type/last scan). */
  project: TargetProject;
  /** The stored index, or null if the target hasn't been scanned yet. */
  ws: WorkspaceIntel | null;
  /** Optional host environment profile summary (already loaded by the caller). */
  environment?: TargetDashboard["environment"];
}

/** Filenames that count as a deployment signal for the dashboard PEEK. */
function looksLikeDeploySignal(rel: string): boolean {
  const base = rel.split("/").pop() ?? rel;
  const lower = rel.toLowerCase();
  return (
    /^Dockerfile/i.test(base) ||
    /^docker-compose.*\.ya?ml$/i.test(base) ||
    /^Jenkinsfile$/i.test(base) ||
    /^\.gitlab-ci\.ya?ml$/i.test(base) ||
    /(deployment|service|ingress|configmap)\.ya?ml$/i.test(base) ||
    /(^|\/)\.github\/workflows\//i.test(lower) ||
    /(^|\/)(k8s|kube|kubernetes|helm|cicd)\//i.test(lower) ||
    /(fly\.toml|vercel\.json|render\.yaml|Procfile|app\.yaml|serverless\.ya?ml)$/i.test(base)
  );
}

/** Build the read-only dashboard aggregate. */
export function buildDashboard(opts: DashboardOptions): TargetDashboard {
  const { project, ws, environment } = opts;
  const now = opts.generatedAt;
  const scanned = ws != null && ws.repos.length > 0;

  // --- repo map + confidence rollup ---
  const repoRows: TargetDashboard["repos"] = (ws?.repos ?? []).map((r) => ({
    name: r.name,
    languages: r.languages,
    gitBranch: r.gitBranch,
    gitCommit: r.gitCommit,
    scripts: r.scripts.length,
    routes: r.routes.length,
    services: r.services.length,
    symbols: r.symbols.length,
    envVars: r.envVars.length,
    deployFiles: r.deployFiles.length,
    confidence: r.grounding.confidence,
    freshness: r.grounding.status,
    knownUnknowns: r.knownUnknowns.length,
  }));

  let overallConf: Confidence = scanned ? "high" : "low";
  for (const r of repoRows) overallConf = worse(overallConf, r.confidence);

  // --- known-unknowns rollup (repos + workspace) ---
  const allUnknowns = [
    ...(ws?.repos.flatMap((r) => r.knownUnknowns) ?? []),
    ...(ws?.knownUnknowns ?? []),
  ];
  const byImpact = { high: 0, medium: 0, low: 0 };
  for (const u of allUnknowns) byImpact[u.confidenceImpact]++;
  const top = [...allUnknowns]
    .sort((a, b) => CONF_RANK[b.confidenceImpact] - CONF_RANK[a.confidenceImpact])
    .slice(0, 6)
    .map((u) => ({ title: u.title, detail: u.detail, impact: u.confidenceImpact }));

  // --- command-book summary ---
  let commands: TargetDashboard["commands"] = { total: 0, byCategory: [], sample: [] };
  if (scanned && ws) {
    const book = buildCommandBook(ws);
    const counts = new Map<string, number>();
    for (const e of book.entries) counts.set(e.category, (counts.get(e.category) ?? 0) + 1);
    commands = {
      total: book.entries.length,
      byCategory: [...counts.entries()].map(([category, count]) => ({ category, count })).sort((a, b) => b.count - a.count),
      // Full-ish list so the UI can show the whole command book (capped for sanity).
      sample: book.entries.slice(0, 60).map((e) => ({ repo: e.repo, category: e.category, name: e.name, command: e.command, safety: e.safety })),
    };
  }

  // --- deployment PEEK (signal files only; full report is a separate action) ---
  const signalFiles: string[] = [];
  for (const r of ws?.repos ?? []) {
    for (const f of r.deployFiles) if (looksLikeDeploySignal(f.value)) signalFiles.push(`${r.name}/${f.value}`);
  }
  const deployment: TargetDashboard["deployment"] = {
    hasSignals: signalFiles.length > 0,
    signalFiles: signalFiles.slice(0, 12),
    note: signalFiles.length
      ? `${signalFiles.length} deployment signal file(s) detected — open the deployment report for details.`
      : "No deployment config detected in the stored scan — production deployment is unknown from source.",
  };

  // --- overall freshness from the registry verdict, else stored grounding ---
  const freshness: TargetDashboard["freshness"] =
    project.freshness?.overall === "fresh" ? "fresh"
    : project.freshness?.overall === "stale" ? "known-stale"
    : project.freshness?.overall === "possibly-stale" ? "potentially-stale"
    : scanned ? worstRepoFreshness(repoRows) : "unknown";

  const summary = buildSummary(project, scanned, overallConf, freshness, byImpact, repoRows.length, commands.total, deployment.hasSignals);

  return {
    version: 1,
    generatedAt: now,
    scanned,
    project: {
      id: project.id,
      displayName: project.displayName,
      targetPath: project.targetPath,
      repoType: project.repoType,
      repos: project.repos,
      lastScannedAt: project.lastScannedAt,
      storageDir: project.storageDir,
      description: project.description,
    },
    freshness,
    confidence: { overall: overallConf, perRepo: repoRows.map((r) => ({ repo: r.name, confidence: r.confidence })) },
    knownUnknowns: { total: allUnknowns.length, byImpact, top },
    repos: repoRows,
    commands,
    deployment,
    environment: environment ?? null,
    summary,
  };
}

function worstRepoFreshness(repos: TargetDashboard["repos"]): FreshnessStatus {
  const rank: Record<FreshnessStatus, number> = { "known-stale": 0, "potentially-stale": 1, unverified: 2, fresh: 3 };
  let f: FreshnessStatus = repos.length ? "fresh" : "unverified";
  for (const r of repos) if (rank[r.freshness] < rank[f]) f = r.freshness;
  return f;
}

function buildSummary(
  project: TargetProject,
  scanned: boolean,
  conf: Confidence,
  freshness: string,
  byImpact: { high: number; medium: number; low: number },
  repoCount: number,
  commandCount: number,
  hasDeploy: boolean,
): string {
  if (!scanned) {
    return `\`${project.displayName}\` (${project.repoType}) at \`${project.targetPath}\` has not been scanned yet — run a scan to populate the dashboard. OpenClaw reads this target; it never modifies it.`;
  }
  const unknownNote = byImpact.high
    ? `${byImpact.high} high-impact known-unknown(s) to be aware of`
    : byImpact.high + byImpact.medium + byImpact.low > 0
      ? `${byImpact.high + byImpact.medium + byImpact.low} known-unknown(s) recorded`
      : "no known-unknowns recorded";
  return (
    `\`${project.displayName}\` (${project.repoType}, ${repoCount} repo(s)) — overall confidence ${conf}, freshness ${freshness}. ` +
    `${commandCount} command(s) in the book; ${hasDeploy ? "deployment signals present" : "no deployment config detected"}; ${unknownNote}. ` +
    `This is OpenClaw's stored understanding of an EXTERNAL target it only reads — verify against current source.`
  );
}
