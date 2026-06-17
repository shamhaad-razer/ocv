// Change Confidence Report (08-change-confidence-impact-analysis.md, milestone).
//
// Inspects the LIVE git working-tree changes in each repo (git status/diff is the
// source of truth, NOT the indexed commit) and links changed files to project
// intelligence entities, recommends tests/commands from the command book, and
// reports confidence + known-unknowns + stale warnings + manual-review items.
//
// HONESTY (08-...md §6, 13-...md §11): this MVP NEVER says "safe to push". It
// states what is directly evidenced vs inferred vs unknown, and it RECOMMENDS
// tests rather than running them (no safe exec-confirm path exists yet — 08-...md
// §5 / OQ2). Pure read: it never mutates a repo.

import { buildGrounding, readGitChanges, readGitInfo } from "./grounding.js";
import { buildCommandBook } from "./onboarding.js";
import { findReferences } from "./references.js";
import { listRepoFiles } from "./explain.js";
import { flowForRepo } from "./flowmap.js";
import type {
  AffectedSymbol,
  ChangeConfidenceReport,
  ChangedFile,
  CommandBook,
  Confidence,
  Finding,
  FlowImpact,
  Grounding,
  KnownUnknown,
  RecommendedCommand,
  RepoChangeReport,
  RepoIntel,
  SourceRef,
  VerificationStore,
  WorkspaceIntel,
} from "./types.js";
import { commandVerification } from "./verify.js";

export interface ChangeOptions {
  generatedAt: number;
  /** Repo root paths to inspect (defaults to the indexed repos' rootPaths). */
  repoRoots?: { name: string; rootPath: string }[];
  /** Prior verification results (from `verify`), to fold runtime evidence in. */
  verification?: VerificationStore | null;
}

function changeKindFromStatus(status: string): ChangedFile["changeKind"] {
  if (status === "??") return "untracked";
  const x = status.trim();
  if (x.startsWith("A")) return "added";
  if (x.startsWith("D")) return "deleted";
  if (x.startsWith("R")) return "renamed";
  if (x.includes("M")) return "modified";
  return "other";
}

function classifyFile(path: string): keyof RepoChangeReport["summary"] {
  const base = path.split("/").pop() ?? path;
  if (/\.(test|spec)\.[tj]sx?$|(^|\/)tests?\/|(^|\/)__tests__\/|conftest\.py$|_test\.py$/.test(path)) return "test";
  if (/Dockerfile|docker-compose|bitbucket-pipelines|(^|\/)cicd\/|\.github\/workflows\//.test(path)) return "deploy";
  if (/(^|\/)\.env|\.ya?ml$|\.toml$|\.json$|config|tsconfig|next\.config/.test(base)) return "config";
  if (/(^|\/)readme|(^|\/)docs\/|\.md$/i.test(path)) return "docs";
  if (/\.(ts|tsx|js|mjs|cjs|py|go|rs)$/.test(path)) return "code";
  return "other";
}

/** All grounded findings on a repo that cite a given file, as affected entities. */
function entitiesForFile(repo: RepoIntel, path: string): ChangedFile["affectedEntities"] {
  const out: ChangedFile["affectedEntities"] = [];
  const cites = (g: Grounding) => g.sources.some((s) => s.ref === path) || g.fileHashes.some((h) => h.ref === path);

  for (const r of repo.routes) {
    if (cites(r.grounding)) out.push({ kind: "route", label: `${r.value.method} ${r.value.pathPattern}`, locator: r.value.locator, confidence: r.grounding.confidence });
  }
  for (const s of repo.scripts) {
    // scripts are keyed to their manifest file (package.json / Makefile)
    if (s.value.source === path) out.push({ kind: "script", label: `${s.value.name} (${s.value.category})`, locator: s.value.source, confidence: s.grounding.confidence });
  }
  for (const sv of repo.services) {
    if (cites(sv.grounding)) out.push({ kind: "service", label: `${sv.value.name} (${sv.value.kind})`, locator: sv.value.evidence, confidence: sv.grounding.confidence });
  }
  for (const sym of repo.symbols) {
    if (sym.value.file === path) out.push({ kind: "symbol", label: `${sym.value.name} (${sym.value.kind})`, locator: sym.value.locator, confidence: sym.grounding.confidence });
  }
  for (const e of repo.envVars) {
    if (e.value.source === path) out.push({ kind: "env-var", label: e.value.name, locator: e.value.source, confidence: e.grounding.confidence });
  }
  for (const d of repo.deployFiles) {
    if (d.value === path) out.push({ kind: "deploy-file", label: d.value, confidence: d.grounding.confidence });
  }
  for (const doc of repo.docFiles) {
    if (doc.value === path) out.push({ kind: "doc", label: doc.value, confidence: doc.grounding.confidence });
  }
  for (const p of repo.packageFiles) {
    if (p.value === path) out.push({ kind: "package-file", label: p.value, confidence: p.grounding.confidence });
  }
  return out;
}

/** Recommend tests/commands from the command book given what kinds of files changed. */
function recommendCommands(
  repoName: string,
  book: CommandBook,
  summary: RepoChangeReport["summary"],
  verification: VerificationStore | null,
): RecommendedCommand[] {
  const entries = book.entries.filter((e) => e.repo === repoName);
  const out: RecommendedCommand[] = [];
  const push = (cat: string, reason: string) => {
    for (const e of entries.filter((x) => x.category === cat)) {
      // If this exact command was actually run (and recorded), reflect its
      // runtime verification — passing raises confidence, failing is surfaced.
      const v = commandVerification(verification, repoName, e.command);
      const verified = v ? v.passed === true : e.runtimeVerified;
      const verifiedReason = v
        ? v.passed
          ? `${reason} — ✓ verified passing (exit ${v.exitCode})`
          : `${reason} — ✗ verified FAILING (exit ${v.exitCode}) — fix before pushing`
        : reason;
      out.push({ repo: repoName, category: e.category, name: e.name, command: e.command, reason: verifiedReason, runtimeVerified: verified, safety: e.safety, mayModify: e.mayModify });
    }
  };
  // Any code/config/test change → run tests + lint. Deploy change → also flag build.
  if (summary.code > 0 || summary.config > 0 || summary.test > 0) {
    push("test", "code/config/test files changed — run the test suite before pushing");
    push("lint", "code/config changed — lint to catch style/type regressions");
  }
  if (summary.deploy > 0) {
    push("build", "deployment/build files changed — verify the build still succeeds");
  }
  if (summary.config > 0) {
    push("build", "config changed — a build may be needed to pick it up");
  }
  // dedupe by repo+name+command
  const seen = new Set<string>();
  return out.filter((c) => {
    const k = `${c.repo}:${c.name}:${c.command}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function mkUnknown(id: string, kind: KnownUnknown["kind"], title: string, detail: string, impact: Confidence): KnownUnknown {
  return { id, kind, title, detail, evidence: [], status: "open", confidenceImpact: impact };
}

function buildRepoReport(
  name: string,
  rootPath: string,
  repoIntel: RepoIntel | undefined,
  book: CommandBook,
  now: number,
  verification: VerificationStore | null,
  flowMap: WorkspaceIntel["flowMap"],
): RepoChangeReport {
  const git = readGitInfo(rootPath);
  const changes = readGitChanges(rootPath);
  const knownUnknowns: KnownUnknown[] = [];
  const highConfidenceNotes: string[] = [];
  const inferredNotes: string[] = [];
  const staleWarnings: string[] = [];
  const doNotKnowYet: string[] = [];
  const manualReview: string[] = [];
  const sources: SourceRef[] = [{ kind: "command", ref: "git status --porcelain", locator: rootPath }];

  const summary = { total: 0, code: 0, config: 0, test: 0, deploy: 0, docs: 0, other: 0 };
  const changedFiles: ChangedFile[] = [];

  if (!git.isGitRepo || changes === null) {
    doNotKnowYet.push("This path is not a git repository, so changes can't be determined.");
    return emptyRepoReport(name, git, changedFiles, summary, [], knownUnknowns, staleWarnings, doNotKnowYet, manualReview, highConfidenceNotes, inferredNotes, now, sources);
  }

  for (const ch of changes) {
    const cls = classifyFile(ch.path);
    summary.total++;
    summary[cls]++;
    const affectedEntities = repoIntel ? entitiesForFile(repoIntel, ch.path) : [];
    const indexed = affectedEntities.length > 0;
    changedFiles.push({
      path: ch.path,
      status: ch.status,
      changeKind: changeKindFromStatus(ch.status),
      added: ch.added,
      deleted: ch.deleted,
      indexed,
      affectedEntities,
    });
  }

  // --- high-confidence (directly evidenced from git) ---
  if (summary.total > 0) {
    highConfidenceNotes.push(`${summary.total} file(s) changed (git working tree): ${summary.code} code, ${summary.config} config, ${summary.test} test, ${summary.deploy} deploy, ${summary.docs} docs.`);
  } else {
    highConfidenceNotes.push("No working-tree changes detected in this repo.");
  }

  // --- affected symbols + their references (the blast radius, prompt 35) ---
  // Symbols defined in changed files; for each, find confidence-classified
  // references across the repo (call/import = likely callers, mention = low).
  const affectedSymbols: AffectedSymbol[] = [];
  if (repoIntel && summary.code > 0) {
    const changedPaths = new Set(changedFiles.map((f) => f.path));
    const changedSymbols = repoIntel.symbols.filter((s) => changedPaths.has(s.value.file)).slice(0, 30);
    const repoFiles = changedSymbols.length ? listRepoFiles(rootPath) : [];
    for (const sym of changedSymbols) {
      const refs = findReferences(rootPath, repoFiles, sym.value.name, sym.value.locator).references
        .filter((r) => r.kind !== "definition") // callers/usages, not the def itself
        .slice(0, 10);
      affectedSymbols.push({
        name: sym.value.name,
        kind: sym.value.kind,
        locator: sym.value.locator,
        references: refs.map((r) => ({ locator: r.locator, kind: r.kind, confidence: r.confidence })),
      });
    }
    if (affectedSymbols.some((s) => s.references.length > 0)) {
      inferredNotes.push(
        `Changed symbols are referenced elsewhere (inferred blast radius): ${affectedSymbols.filter((s) => s.references.length).slice(0, 5).map((s) => `${s.name} (${s.references.length} ref)`).join(", ")} — verify these callers.`,
      );
      manualReview.push(`Review call sites of changed symbols (references are text-matched, not a proven call graph): ${affectedSymbols.filter((s) => s.references.length).map((s) => s.name).slice(0, 6).join(", ")}.`);
    }
  }

  // --- cross-repo flow impact (inferred, prompt 34/35) ---
  const flowImpact: FlowImpact[] = flowMap
    ? flowForRepo(flowMap, name).edges.map((e) => ({ from: e.from, to: e.to, kind: e.kind, label: e.label, confidence: e.confidence }))
    : [];
  if (flowImpact.length && summary.total > 0) {
    inferredNotes.push(`This repo has ${flowImpact.length} inferred cross-repo link(s); a change here may affect: ${flowImpact.map((e) => (e.from === name ? e.to : e.from)).slice(0, 4).join(", ")}.`);
    manualReview.push(`Cross-repo: verify the other side of ${flowImpact.map((e) => `${e.from}→${e.to}`).slice(0, 4).join(", ")} (links are inferred, not proven).`);
  }

  // --- affected entities (inferred — index links are heuristic for code files) ---
  const withEntities = changedFiles.filter((f) => f.affectedEntities.length);
  if (withEntities.length) {
    inferredNotes.push(
      `Index links ${withEntities.length} changed file(s) to entities: ` +
        withEntities.map((f) => `${f.path} → ${f.affectedEntities.map((e) => e.kind).join("/")}`).slice(0, 8).join("; "),
    );
  }

  // --- deploy / config changes warrant explicit manual review ---
  if (summary.deploy > 0) manualReview.push("Deployment/CI files changed — review pipeline + Dockerfile impact carefully (this MVP does not validate deploys).");
  if (summary.config > 0) manualReview.push("Config/env files changed — verify required env vars and that no secrets were committed.");
  const codeChangedNoTest = summary.code > 0 && summary.test === 0;
  if (codeChangedNoTest) manualReview.push("Code changed but no test files changed — consider whether tests should be updated.");

  // --- known unknowns ---
  if (!repoIntel) {
    knownUnknowns.push(mkUnknown(`${name}:no-index`, "other", "repo not in index", "No project-intelligence scan for this repo, so changed files can't be linked to entities. Run `npm run scan`.", "high"));
    doNotKnowYet.push("Which routes/flows/services these changes affect (no index for this repo).");
  } else {
    // we have an index, but no call graph → can't trace flow impact
    knownUnknowns.push(mkUnknown(`${name}:no-call-graph`, "shallow-graph", "no call graph — flow/caller impact unknown", "Changed code can't be traced to callers or end-to-end flows; only direct file→entity links are known (milestone 4).", "medium"));
    doNotKnowYet.push("Whether these changes break callers or cross-repo flows (no call graph yet).");
  }
  // tests: reflect runtime verification if it happened, else flag as unrun.
  const ranTests = (verification?.results ?? []).filter((r) => r.repo === name && r.kind === "test-command" && r.status === "ran");
  if (ranTests.length === 0) {
    knownUnknowns.push(mkUnknown(`${name}:tests-unrun`, "unvalidated-command", "tests not run", "Recommended tests have NOT been executed (no runtime verification). Their pass/fail is unknown — run `verify --run <cmd> --confirm`.", "medium"));
  } else {
    const failed = ranTests.filter((r) => r.passed === false);
    if (failed.length) {
      manualReview.push(`Runtime verification FAILED for: ${failed.map((r) => `\`${r.command}\``).join(", ")} — fix before pushing.`);
      highConfidenceNotes.push(`${ranTests.length} command(s) were runtime-verified; ${failed.length} FAILED.`);
    } else {
      highConfidenceNotes.push(`${ranTests.length} recommended command(s) were runtime-verified PASSING (exit 0).`);
    }
  }

  // --- stale warnings: changed files invalidate index entities grounded on them ---
  for (const f of withEntities) {
    staleWarnings.push(`\`${f.path}\` changed → its ${f.affectedEntities.length} indexed entity(ies) may be stale; re-run \`npm run scan\`.`);
  }
  if (repoIntel && summary.total > 0 && withEntities.length === 0) {
    staleWarnings.push("Changed files don't map to indexed entities — the index may be coarse here; a re-scan will refresh freshness anchors.");
  }

  const recommendedCommands = recommendCommands(name, book, summary, verification);
  if (recommendedCommands.length === 0 && summary.total > 0) {
    doNotKnowYet.push("No test/lint/build commands are known for this repo (command book empty) — can't recommend what to run.");
  }

  const grounding: Grounding = buildGrounding({
    generatedAt: now,
    baseCommit: git.commit,
    sources,
    analysisQuality: "declared", // the git facts are declared; entity links are noted as inferred above
    knownUnknownIds: knownUnknowns.map((u) => u.id),
  });

  return {
    repo: name,
    branch: git.branch,
    headCommit: git.commit,
    isGitRepo: git.isGitRepo,
    changedFiles,
    summary,
    affectedSymbols,
    flowImpact,
    recommendedCommands,
    highConfidenceNotes,
    inferredNotes,
    knownUnknowns,
    staleWarnings,
    doNotKnowYet,
    manualReview,
    grounding,
  };
}

function emptyRepoReport(
  name: string,
  git: { branch: string | null; commit: string | null; isGitRepo: boolean },
  changedFiles: ChangedFile[],
  summary: RepoChangeReport["summary"],
  recommendedCommands: RecommendedCommand[],
  knownUnknowns: KnownUnknown[],
  staleWarnings: string[],
  doNotKnowYet: string[],
  manualReview: string[],
  highConfidenceNotes: string[],
  inferredNotes: string[],
  now: number,
  sources: SourceRef[],
): RepoChangeReport {
  return {
    repo: name,
    branch: git.branch,
    headCommit: git.commit,
    isGitRepo: git.isGitRepo,
    changedFiles,
    summary,
    affectedSymbols: [],
    flowImpact: [],
    recommendedCommands,
    highConfidenceNotes,
    inferredNotes,
    knownUnknowns,
    staleWarnings,
    doNotKnowYet,
    manualReview,
    grounding: buildGrounding({ generatedAt: now, baseCommit: git.commit, sources, analysisQuality: "declared" }),
  };
}

export function buildChangeReport(ws: WorkspaceIntel, opts: ChangeOptions): ChangeConfidenceReport {
  const now = opts.generatedAt;
  const book = buildCommandBook(ws);
  const roots = opts.repoRoots ?? ws.repos.map((r) => ({ name: r.name, rootPath: r.rootPath }));

  const verification = opts.verification ?? null;
  const repos: RepoChangeReport[] = roots.map((root) => {
    const intel = ws.repos.find((r) => r.name === root.name);
    return buildRepoReport(root.name, root.rootPath, intel, book, now, verification, ws.flowMap);
  });

  const totalChanged = repos.reduce((n, r) => n + r.summary.total, 0);
  const reposChanged = repos.filter((r) => r.summary.total > 0).map((r) => r.repo);
  const anyVerified = (verification?.results ?? []).some((r) => r.kind === "test-command" && r.status === "ran");
  const anyFailed = (verification?.results ?? []).some((r) => r.kind === "test-command" && r.passed === false);

  // The verdict NEVER claims "safe" — it states scope + what's verified vs not.
  const verdict =
    totalChanged === 0
      ? "No working-tree changes detected across the inspected repos."
      : `${totalChanged} changed file(s) across ${reposChanged.length} repo(s) (${reposChanged.join(", ")}). ` +
        (anyFailed
          ? "Some runtime-verified checks FAILED — do not push until fixed. "
          : anyVerified
            ? "Some recommended checks were runtime-verified passing, but flow impact is still not traced. "
            : "Recommended tests have NOT been run and flow impact is not traced. ") +
        "Review the manual-review items and run the recommended commands before pushing. This report does not assert the changes are safe.";

  return {
    generatedAt: now,
    scanVersion: ws.scanVersion,
    targetPath: ws.targetPath ?? ws.rootPath,
    indexAvailable: ws.repos.length > 0,
    repos,
    verdict,
  };
}
