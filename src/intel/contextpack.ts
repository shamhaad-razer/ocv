// Automatic Context Pack Builder (prompt 37). Pure + host-independent.
//
// THE problem this solves: the user shouldn't have to hand-make context files and
// attach them to a chat. Given {projectId, question, optional file/line/selection,
// mode}, this gathers the RELEVANT source-grounded project intelligence (from the
// already-scanned index + the user's remembered preferences) and packages it into
// one compact `ContextPack` the LLM/explanation system can consume directly.
//
// Principles (carried from 04-...md + 13-...md + 36):
//   - RELEVANCE, not everything: a token budget + per-mode lens keep the pack
//     compact so the LLM isn't overloaded (req #5). Items are ranked, then capped.
//   - SOURCE-GROUNDED: every item cites its sources (req #3).
//   - HONEST: every item carries freshness + confidence, and stale/uncertain items
//     are MARKED (req #4); the pack's overall confidence is the WORST item's.
//   - READ-ONLY: this module only reads the index + (via explain) the working tree.
//     It NEVER writes into the target (req #8). Persisting a pack for debugging is
//     the CLI's job, and only ever to HOST storage (req #9).
//
// It composes the existing building blocks (explainSelection, the command book,
// the flow map, known-unknowns) rather than re-deriving anything.

import { explainSelection, listRepoFiles } from "./explain.js";
import { buildCommandBook } from "./onboarding.js";
import { buildDeploymentReport } from "./deployment.js";
import { flowForRepo } from "./flowmap.js";
import type { Guidance } from "./memory.js";
import type {
  CommandBookEntry,
  Confidence,
  ContextItem,
  ContextMode,
  ContextPack,
  ContextPackRequest,
  FreshnessStatus,
  KnownUnknown,
  RepoIntel,
  SourceRef,
  WorkspaceIntel,
} from "./types.js";

export interface ContextPackOptions {
  generatedAt: number;
  /** The remembered presentation guidance (prompt 36). Required: prefs always exist. */
  guidance: Guidance;
  /** Max items to include (the relevance budget). Default 24 — compact by design. */
  maxItems?: number;
}

const DEFAULT_BUDGET = 24;
const CONF_RANK: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };
const FRESH_RANK: Record<FreshnessStatus, number> = { "known-stale": 0, "potentially-stale": 1, unverified: 2, fresh: 3 };

/** WORST (most conservative) of two confidence levels — the pack never over-claims. */
function worse(a: Confidence, b: Confidence): Confidence {
  return CONF_RANK[a] <= CONF_RANK[b] ? a : b;
}
function worseFresh(a: FreshnessStatus, b: FreshnessStatus): FreshnessStatus {
  return FRESH_RANK[a] <= FRESH_RANK[b] ? a : b;
}
/** Is a freshness/confidence pairing uncertain enough to flag? (req #4) */
function isUncertain(conf: Confidence, fresh: FreshnessStatus): boolean {
  return conf === "low" || fresh === "potentially-stale" || fresh === "known-stale" || fresh === "unverified";
}

/** Tokenize a question into lowercase word stems for cheap keyword relevance. */
function tokenize(text: string): Set<string> {
  return new Set(
    (text.toLowerCase().match(/[a-z0-9_]+/g) ?? []).filter((w) => w.length >= 3 && !STOPWORDS.has(w)),
  );
}
const STOPWORDS = new Set([
  "the", "and", "for", "what", "how", "why", "does", "this", "that", "with", "from", "into", "are", "was",
  "where", "when", "which", "who", "can", "you", "would", "should", "could", "have", "has", "had", "its",
  "it", "is", "do", "to", "of", "in", "on", "a", "an", "code", "file", "function", "work", "works",
]);

/** Score an item's text against the question tokens (overlap count). 0 = no match. */
function relevanceScore(text: string, qTokens: Set<string>): number {
  if (qTokens.size === 0) return 0;
  const t = tokenize(text);
  let n = 0;
  for (const w of t) if (qTokens.has(w)) n++;
  return n;
}

/** A scored candidate before budgeting. */
interface Candidate extends ContextItem {
  /** Higher = more relevant; ties broken by confidence then freshness. */
  score: number;
  /** Items the mode considers ESSENTIAL bypass the relevance floor (always kept first). */
  essential: boolean;
}

function mk(
  kind: ContextItem["kind"],
  label: string,
  content: string,
  reason: string,
  sources: SourceRef[],
  confidence: Confidence,
  freshness: FreshnessStatus,
  score: number,
  essential = false,
): Candidate {
  return { kind, label, content, reason, sources, confidence, freshness, uncertain: isUncertain(confidence, freshness), score, essential };
}

/**
 * Which item kinds each mode prioritizes. Items of a non-priority kind still
 * compete on relevance, but priority kinds get a score boost so the pack leans
 * toward what the mode is about (req #1/#5).
 */
const MODE_PRIORITY: Record<ContextMode, ContextItem["kind"][]> = {
  onboarding: ["repo-summary", "command", "doc-file", "route", "known-unknown"],
  explain: ["selected-code", "nearby-code", "symbol", "reference", "route", "flow-edge"],
  "change-confidence": ["symbol", "reference", "command", "flow-edge", "known-unknown"],
  deployment: ["deploy-file", "env-var", "command", "flow-edge", "known-unknown"],
  "command-help": ["command", "env-var", "doc-file", "repo-summary"],
};
const PRIORITY_BOOST = 3;

/**
 * Build a compact, relevance-selected, source-grounded context pack for a request.
 * Pure: no I/O beyond what explainSelection reads (the working tree for the
 * selected file); never writes anything.
 */
export function buildContextPack(req: ContextPackRequest, ws: WorkspaceIntel, opts: ContextPackOptions): ContextPack {
  const now = opts.generatedAt;
  const mode: ContextMode = req.mode ?? "explain";
  const budget = opts.maxItems ?? DEFAULT_BUDGET;
  const targetPath = ws.targetPath ?? ws.rootPath;
  const qTokens = tokenize(`${req.question} ${req.filePath ?? ""}`);
  const priority = new Set(MODE_PRIORITY[mode]);
  const candidates: Candidate[] = [];
  const knownUnknowns: KnownUnknown[] = [];

  // Resolve the repo: explicit, else the one owning filePath, else the only repo.
  const repo =
    (req.repo && ws.repos.find((r) => r.name === req.repo)) ||
    (req.filePath ? ws.repos.find((r) => r.name === req.filePath!.split("/")[0]) : undefined) ||
    (ws.repos.length === 1 ? ws.repos[0] : undefined);

  // --- project metadata (always essential — the "what am I looking at") ---
  candidates.push(
    mk(
      "project-metadata",
      `target: ${targetPath}`,
      `Target project at \`${targetPath}\` · ${ws.repos.length} repo(s): ${ws.repos.map((r) => r.name).join(", ")} · scan version ${ws.scanVersion}.`,
      "every pack states which project + scan it draws from",
      [{ kind: "intel-entity", ref: "workspace", locator: targetPath }],
      ws.repos.length ? "high" : "low",
      overallFreshnessOf(ws),
      99,
      true,
    ),
  );

  // --- repo summary (essential when a repo is in scope) ---
  if (repo) {
    candidates.push(repoSummaryItem(repo));
    // commands relevant to the repo / question
    candidates.push(...commandItems(ws, repo, qTokens, mode));
    // routes
    candidates.push(...routeItems(repo, qTokens));
    // env vars + deploy files (names only — never values, S6)
    candidates.push(...envItems(repo, qTokens));
    candidates.push(...deployItems(repo, qTokens));
    candidates.push(...docItems(repo, qTokens));
    // repo-level known unknowns
    for (const u of repo.knownUnknowns) {
      candidates.push(knownUnknownItem(u, repo.name));
      knownUnknowns.push(u);
    }
  }

  // --- code-centric context via the existing explain engine ---
  // Only when we have a file (+range). This gives selected code, nearby symbols,
  // references and flow context — already source-grounded + confidence-scored.
  if (repo && req.filePath && req.startLine) {
    const repoFiles = listRepoFiles(repo.rootPath);
    const pkg = explainSelection(
      {
        repo: repo.name,
        path: stripRepoPrefix(req.filePath, repo.name),
        startLine: req.startLine,
        endLine: req.endLine ?? req.startLine,
        intent: req.question,
        selectedText: req.selectedCode,
      },
      ws,
      { generatedAt: now, repoFiles, guidance: opts.guidance },
    );
    if (pkg.selectedCode) {
      candidates.push(
        mk(
          "selected-code",
          `${pkg.request.path}:${pkg.request.startLine}-${pkg.request.endLine}`,
          pkg.selectedCode,
          "the exact code the question is about",
          pkg.evidence.sources,
          pkg.confidence,
          pkg.freshness,
          100,
          true,
        ),
      );
    }
    if (pkg.enclosingSymbol) {
      candidates.push(
        mk(
          "symbol",
          `enclosing: ${pkg.enclosingSymbol.name} (${pkg.enclosingSymbol.kind})`,
          pkg.enclosingSymbol.signature ?? pkg.enclosingSymbol.name,
          "the symbol that encloses the selection",
          [{ kind: "file", ref: pkg.enclosingSymbol.locator }],
          pkg.confidence,
          pkg.freshness,
          PRIORITY_BOOST + 6,
          true,
        ),
      );
    }
    for (const s of pkg.symbolsInRange.slice(0, 5)) {
      candidates.push(
        mk("symbol", `${s.name} (${s.kind})`, s.signature ?? s.name, "symbol defined in the selected range", [{ kind: "file", ref: s.locator }], pkg.confidence, pkg.freshness, 5),
      );
    }
    // references (callers/usages) — explicitly inferred, capped, confidence-scored
    for (const ref of pkg.references.filter((r) => r.kind !== "definition").slice(0, 6)) {
      candidates.push(
        mk(
          "reference",
          `ref → ${ref.kind} @ ${ref.locator}`,
          ref.snippet,
          "a likely caller/usage (text-matched, not a proven call)",
          [{ kind: "file", ref: ref.locator }],
          ref.confidence,
          pkg.freshness,
          4,
        ),
      );
    }
    // flow context (cross-repo, inferred)
    for (const e of pkg.flowContext.slice(0, 4)) {
      candidates.push(
        mk("flow-edge", `${e.from} → ${e.to} (${e.kind})`, e.label, "inferred cross-repo link touching this repo", [{ kind: "intel-entity", ref: `flow:${e.from}->${e.to}` }], e.confidence, pkg.freshness, 3),
      );
    }
    // explain's own known-unknowns
    for (const u of pkg.knownUnknowns) {
      candidates.push(knownUnknownItem(u, repo.name));
      knownUnknowns.push(u);
    }
    if (pkg.staleWarning) {
      candidates.push(
        mk("known-unknown", "selection may be stale", pkg.staleWarning, "the file changed since the last scan", pkg.evidence.sources, "low", "potentially-stale", PRIORITY_BOOST + 2, true),
      );
    }
  } else if (mode === "explain" && (!req.filePath || !req.startLine)) {
    // Honest gap: explain mode without a concrete selection can't ground code.
    knownUnknowns.push({
      id: "contextpack:no-selection",
      kind: "other",
      title: "no file/line selection",
      detail: "explain mode without a file+line range can only include project-level context; provide a selection to ground code-level items.",
      evidence: [],
      status: "open",
      confidenceImpact: "medium",
    });
  }

  // --- cross-repo flow edges (deployment/change modes care about these) ---
  if (ws.flowMap && repo) {
    for (const e of flowForRepo(ws.flowMap, repo.name).edges.slice(0, 4)) {
      candidates.push(
        mk("flow-edge", `${e.from} → ${e.to} (${e.kind})`, e.label, "inferred cross-repo relationship", e.evidence, e.confidence, "unverified", 2),
      );
    }
  }

  // --- deployment context (prompt 38): in deployment mode, fold in the detected
  // deployment signals + inferred runtime deps + the honest unknown so the pack
  // can answer "how is this deployed?" without the user attaching configs. ---
  if (mode === "deployment") {
    const dep = buildDeploymentReport(ws, { generatedAt: now });
    const scope = repo ? dep.repos.filter((r) => r.repo === repo.name) : dep.repos;
    for (const rd of scope) {
      for (const s of rd.signals.slice(0, 8)) {
        candidates.push(
          mk(
            "deploy-file",
            `${s.type}: ${s.sourceFile}`,
            s.summary + (s.ports.length ? ` · ports ${s.ports.join(", ")}` : "") + (s.commands.length ? ` · e.g. \`${s.commands[0]}\`` : ""),
            "a detected deployment signal",
            s.sources,
            s.confidence,
            s.freshness,
            PRIORITY_BOOST + 5,
          ),
        );
      }
      for (const d of rd.runtimeDependencies.slice(0, 6)) {
        candidates.push(
          mk("flow-edge", `runtime dep → ${d.to}`, `${rd.repo} likely needs ${d.to} (${d.kind}, via ${d.via})`, "inferred runtime dependency for deployment", d.sources, d.confidence, "unverified", PRIORITY_BOOST + 2),
        );
      }
    }
    // The headline honesty for deployment: production topology is unknown.
    candidates.push(
      mk("known-unknown", "production deployment", dep.unknown[0] ?? "Live production topology is not observable from source.", "deployment configs ≠ live deployment", [{ kind: "intel-entity", ref: "deploy:unknown" }], "low", "unverified", PRIORITY_BOOST + 1),
    );
  }

  // --- workspace-level known unknowns (always honest about gaps) ---
  for (const u of ws.knownUnknowns.slice(0, 4)) {
    candidates.push(knownUnknownItem(u, "workspace"));
    knownUnknowns.push(u);
  }

  // ---- relevance scoring + budgeting ----
  for (const c of candidates) {
    const rel = relevanceScore(`${c.label} ${c.content} ${c.reason}`, qTokens);
    c.score += rel + (priority.has(c.kind) ? PRIORITY_BOOST : 0);
  }
  // Sort: essential first, then score, then confidence, then freshness.
  candidates.sort((a, b) => {
    if (a.essential !== b.essential) return a.essential ? -1 : 1;
    if (b.score !== a.score) return b.score - a.score;
    if (CONF_RANK[b.confidence] !== CONF_RANK[a.confidence]) return CONF_RANK[b.confidence] - CONF_RANK[a.confidence];
    return FRESH_RANK[b.freshness] - FRESH_RANK[a.freshness];
  });

  const candidateCount = candidates.length;
  const chosen = candidates.slice(0, budget);
  const droppedForBudget = Math.max(0, candidateCount - chosen.length);

  const items: ContextItem[] = chosen.map(({ score: _s, essential: _e, ...item }) => item);

  // Overall freshness/confidence = worst included CLAIM (never over-claims).
  // known-unknown items are gaps, not claims, so they don't drag the overall
  // down — they're surfaced per-item + in knownUnknowns instead.
  const claims = items.filter((i) => i.kind !== "known-unknown");
  let confidence: Confidence = claims.length ? "high" : "low";
  let freshness: FreshnessStatus = claims.length ? "fresh" : "unverified";
  for (const it of claims) {
    confidence = worse(confidence, it.confidence);
    freshness = worseFresh(freshness, it.freshness);
  }

  const uncertainCount = items.filter((i) => i.uncertain).length;
  const summary =
    `Context pack for "${req.question}" (mode: ${mode}). ` +
    `${items.length} of ${candidateCount} candidate item(s) included` +
    (droppedForBudget ? `, ${droppedForBudget} dropped to stay within budget (${budget})` : "") +
    `. Overall confidence ${confidence}, freshness ${freshness}. ` +
    (uncertainCount ? `${uncertainCount} item(s) marked uncertain/stale — hedge accordingly. ` : "") +
    `Presented for a ${opts.guidance.level} engineer. ` +
    `This pack is assembled from a static scan; verify code-level claims against the current source.`;

  // De-dupe known unknowns by id.
  const seenU = new Set<string>();
  const dedupUnknowns = knownUnknowns.filter((u) => (seenU.has(u.id) ? false : (seenU.add(u.id), true)));

  return {
    version: 1,
    generatedAt: now,
    scanVersion: ws.scanVersion,
    request: req,
    targetPath,
    mode,
    items,
    guidance: { level: opts.guidance.level, lines: opts.guidance.lines },
    freshness,
    confidence,
    knownUnknowns: dedupUnknowns,
    selection: { candidates: candidateCount, included: items.length, budget, droppedForBudget },
    summary,
  };
}

// --------------------------------------------------------------------------
// per-kind candidate builders (each source-grounded + confidence/freshness)
// --------------------------------------------------------------------------

function overallFreshnessOf(ws: WorkspaceIntel): FreshnessStatus {
  let f: FreshnessStatus = ws.repos.length ? "fresh" : "unverified";
  for (const r of ws.repos) f = worseFresh(f, r.grounding.status);
  return f;
}

function repoSummaryItem(repo: RepoIntel): Candidate {
  const langs = repo.languages.join(", ") || "?";
  const counts = `${repo.routes.length} route(s), ${repo.scripts.length} script(s), ${repo.symbols.length} symbol(s), ${repo.envVars.length} env var(s)`;
  return mk(
    "repo-summary",
    `repo: ${repo.name}`,
    `\`${repo.name}\` (${langs}) on \`${repo.gitBranch ?? "?"}\`@\`${repo.gitCommit ?? "?"}\`. Contains ${counts}.`,
    "summarizes the repo in scope so the LLM has orientation",
    [{ kind: "dir", ref: repo.name, locator: repo.rootPath }],
    repo.grounding.confidence,
    repo.grounding.status,
    PRIORITY_BOOST + 7,
    true,
  );
}

function commandItems(ws: WorkspaceIntel, repo: RepoIntel, qTokens: Set<string>, mode: ContextMode): Candidate[] {
  const book = buildCommandBook(ws);
  const entries = book.entries.filter((e) => e.repo === repo.name);
  // Always keep a couple of high-value categories; the rest compete on relevance.
  const wanted: CommandBookEntry["category"][] =
    mode === "deployment" ? ["deploy", "docker", "build"] : mode === "command-help" ? ["install", "setup", "test", "lint", "build", "dev"] : ["test", "lint", "build"];
  return entries.map((e) => {
    const base = wanted.includes(e.category) ? 2 : 0;
    return mk(
      "command",
      `${e.category}: ${e.name}`,
      `\`${e.command}\` — safety: ${e.safety}${e.mayModify ? " (may modify)" : ""}.`,
      "a command relevant to the task",
      [{ kind: "file", ref: e.sourceFile, locator: e.sourceLocator }],
      e.confidence,
      e.freshness,
      base,
    );
  });
}

function routeItems(repo: RepoIntel, _qTokens: Set<string>): Candidate[] {
  return repo.routes.slice(0, 12).map((r) =>
    mk(
      "route",
      `${r.value.method} ${r.value.pathPattern}`,
      `Route \`${r.value.method} ${r.value.pathPattern}\` at \`${r.value.locator}\`.`,
      "an HTTP/WS endpoint in the repo",
      [{ kind: "file", ref: r.value.locator }],
      r.grounding.confidence,
      r.grounding.status,
      1,
    ),
  );
}

function envItems(repo: RepoIntel, _qTokens: Set<string>): Candidate[] {
  // Names only — values are NEVER read or stored (S6).
  return repo.envVars.slice(0, 20).map((e) =>
    mk(
      "env-var",
      `env: ${e.value.name}`,
      `Environment variable \`${e.value.name}\` (declared in \`${e.value.source}\`; value never read).`,
      "a configuration variable the project references",
      [{ kind: "file", ref: e.value.source }],
      e.grounding.confidence,
      e.grounding.status,
      1,
    ),
  );
}

function deployItems(repo: RepoIntel, _qTokens: Set<string>): Candidate[] {
  return repo.deployFiles.slice(0, 8).map((f) =>
    mk(
      "deploy-file",
      `deploy: ${f.value}`,
      `Deployment/CI file \`${f.value}\`.`,
      "deployment/config surface relevant to shipping",
      [{ kind: "file", ref: f.value }],
      f.grounding.confidence,
      f.grounding.status,
      1,
    ),
  );
}

function docItems(repo: RepoIntel, _qTokens: Set<string>): Candidate[] {
  return repo.docFiles.slice(0, 6).map((f) =>
    mk(
      "doc-file",
      `doc: ${f.value}`,
      `Documentation file \`${f.value}\`.`,
      "project documentation that may answer the question",
      [{ kind: "file", ref: f.value }],
      f.grounding.confidence,
      f.grounding.status,
      1,
    ),
  );
}

function knownUnknownItem(u: KnownUnknown, scope: string): Candidate {
  // A known-unknown may carry no file evidence; cite the gap itself so every
  // context item is traceable (req #3).
  const sources: SourceRef[] = u.evidence.length ? u.evidence : [{ kind: "intel-entity", ref: `known-unknown:${u.id}`, locator: scope }];
  return mk(
    "known-unknown",
    `unknown: ${u.title}`,
    `${u.detail} (${scope})`,
    "an explicit gap in what the scan knows — surfaced so the LLM doesn't assume",
    sources,
    "low",
    "unverified",
    1,
  );
}

/** If a path is prefixed with the repo name (e.g. "web/src/x.ts"), strip it. */
function stripRepoPrefix(path: string, repoName: string): string {
  return path.startsWith(`${repoName}/`) ? path.slice(repoName.length + 1) : path;
}
