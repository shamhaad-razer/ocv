// Project Intelligence Model — MVP entity + grounding types.
//
// This is the data substrate for the onboarding assistant (see the design series
// in the workspace root: 04-project-intelligence-model.md, 13-freshness-...md).
// It is deliberately host-independent: nothing here imports the `openclaw` host
// runtime, so the scanner can run standalone today and be called from the plugin
// (dispatch.ts) later without change.
//
// Core principle (13-freshness-reindexing-confidence.md §11): no finding is
// emitted without a Grounding block. A claim with no source is, by definition,
// low confidence and unverified — and says so.

/** How a fact was derived. Drives the confidence calculus. */
export type AnalysisQuality = "declared" | "parsed" | "heuristic" | "inferred";

/** Confidence level shown to the user. Computed, never hand-waved (§5). */
export type Confidence = "high" | "medium" | "low";

/** Freshness verdict for an artifact/entity (§1). Derived from hashes, not asserted. */
export type FreshnessStatus = "fresh" | "potentially-stale" | "known-stale" | "unverified";

/** Whether knowledge is statically inferred or confirmed by running something (§7). */
export type Verification = "static" | "runtime-verified" | "runtime-failed" | "none";

/** A single traceable evidence pointer. Every finding carries >=1 of these (§4). */
export interface SourceRef {
  kind: "file" | "dir" | "commit" | "command" | "runtime-check" | "user-input" | "intel-entity";
  /** Repo-relative path / sha / command line / endpoint / entityId. */
  ref: string;
  /** Optional finer locator, e.g. "file:line", a config key, a route pattern. */
  locator?: string;
  /** Content hash of the source where applicable (sha256, first 16 hex chars). */
  hash?: string;
}

/** Inputs the confidence level is computed from (§5). Recorded for transparency. */
export interface ConfidenceBasis {
  sourceCoverage: "complete" | "partial" | "none";
  freshness: FreshnessStatus;
  analysisQuality: AnalysisQuality;
  runtimeVerification: "verified" | "failed" | "none";
  /** Expected-but-absent sources that cap confidence. */
  missingFiles: string[];
}

/**
 * The mandatory provenance/freshness/confidence block carried by every entity
 * and artifact (13-freshness-reindexing-confidence.md §1). This is the spine.
 */
export interface Grounding {
  /** Engine/heuristic version. Bump invalidates all derived knowledge (derive-level stale). */
  scanVersion: string;
  /** Epoch ms when produced. Stamped at the edge (cli.ts), never inside pure scan code. */
  generatedAt: number;
  /** Everything this was derived from — the citations. */
  sources: SourceRef[];
  /** Repo HEAD sha at generation time, or null if not a git repo / unavailable. */
  baseCommit: string | null;
  /** Per-source-file content hashes, so staleness is checkable without re-deriving. */
  fileHashes: { ref: string; hash: string }[];
  status: FreshnessStatus;
  /** Why, if not fresh — which source drifted. */
  staleReason?: string;
  confidence: Confidence;
  confidenceBasis: ConfidenceBasis;
  verification: Verification;
  /** Ids of open known-unknowns that touch this artifact (§6). */
  knownUnknownIds: string[];
}

/** A finding = a detected fact + its grounding. The unit of grounded knowledge. */
export interface Finding<T> {
  value: T;
  grounding: Grounding;
}

// ----- Detected entities (MVP subset of 04-project-intelligence-model.md) -----

export interface DetectedScript {
  name: string;
  command: string;
  /** "package.json" | "Makefile" | "composer" etc. */
  source: string;
  /** Rough category for the command book (07-command-and-setup-assistant.md §0). */
  category:
    | "install"
    | "setup"
    | "dev-server"
    | "test"
    | "lint"
    | "build"
    | "deploy"
    | "docker"
    | "database"
    | "inspect"
    | "other";
}

export interface DetectedService {
  name: string;
  kind: "http" | "ws" | "worker" | "frontend" | "cli" | "unknown";
  /** Evidence file that revealed the service. */
  evidence: string;
  defaultPort?: number;
}

export interface DetectedRoute {
  method: string;
  pathPattern: string;
  /** "file:line" where it was matched. */
  locator: string;
}

/** A symbol (function/class/etc.) extracted at scan time and stored in the index. */
export interface DetectedSymbol {
  name: string;
  kind: "function" | "class" | "method" | "const" | "route" | "unknown";
  /** "file:line" where it is defined. */
  locator: string;
  /** Repo-relative file the symbol is defined in. */
  file: string;
  /** Whether it appears exported (TS/JS `export`, Python module-top def). */
  exported: boolean;
  /** Trimmed declaration line (evidence). */
  signature?: string;
}

export interface DetectedEnvVar {
  /** Name only — values are never read or stored (S6). */
  name: string;
  /** File the name was found in (e.g. ".env.example"). */
  source: string;
}

/** A first-class, queryable gap in the system's own knowledge (§6). */
export interface KnownUnknown {
  id: string;
  kind:
    | "missing-deploy-config"
    | "unconfirmed-runtime-dep"
    | "undocumented-env-var"
    | "route-without-caller"
    | "unvalidated-command"
    | "possibly-stale-doc"
    | "external-service-behavior"
    | "shallow-graph"
    | "missing-tests"
    // onboarding-doc gaps (milestone 3):
    | "missing-readme"
    | "missing-env-example"
    | "ambiguous-command"
    | "missing-test-command"
    | "missing-deploy-command"
    // local-environment gaps (milestone 4 — env awareness):
    | "missing-tool"
    | "unverified-port"
    | "other";
  title: string;
  detail: string;
  evidence: SourceRef[];
  status: "open" | "mitigated" | "resolved" | "reopened";
  /** How much this gap caps confidence of nearby findings. */
  confidenceImpact: Confidence;
}

/**
 * Transparency record: what the scan actually covered vs. skipped (§ output
 * requirement "what was scanned / what was skipped"). Makes the boundary of the
 * system's knowledge explicit rather than implied.
 */
export interface ScanCoverage {
  /** Count of files inventoried (after ignore rules). */
  filesScanned: number;
  /** Top-level directories that were walked. */
  dirsScanned: string[];
  /** Directory names skipped by the ignore list (vendored/build/etc.). */
  dirsSkipped: string[];
  /** True if the file-walk hit the maxFiles cap (knowledge is incomplete). */
  truncated: boolean;
  /** The cap that was applied. */
  maxFiles: number;
}

/** Per-repo intelligence: the grounded map of one repository. */
export interface RepoIntel {
  name: string;
  rootPath: string;
  gitBranch: string | null;
  gitCommit: string | null;
  isGitRepo: boolean;
  /** Working tree dirty/clean at scan time (null=unknown/non-git). */
  gitDirty?: boolean | null;
  languages: string[];
  coverage: ScanCoverage;
  importantDirs: Finding<string>[];
  packageFiles: Finding<string>[];
  /** README / docs files found (for "what is this repo?"). */
  docFiles: Finding<string>[];
  scripts: Finding<DetectedScript>[];
  services: Finding<DetectedService>[];
  routes: Finding<DetectedRoute>[];
  /** Symbols extracted at scan time (functions/classes/exports), grounded per file. */
  symbols: Finding<DetectedSymbol>[];
  envFiles: Finding<string>[];
  envVars: Finding<DetectedEnvVar>[];
  deployFiles: Finding<string>[];
  knownUnknowns: KnownUnknown[];
  /** Grounding for the repo-level scan as a whole. */
  grounding: Grounding;
}

/** Workspace = the parent dir holding multiple repos. */
export interface WorkspaceIntel {
  /** @deprecated alias of targetPath (kept for back-compat with earlier scans). */
  rootPath: string;
  /** The TARGET PROJECT path this index describes (the external project studied). */
  targetPath?: string;
  scanVersion: string;
  generatedAt: number;
  repos: RepoIntel[];
  /** Workspace-level gaps (incl. cross-repo edges the flow map couldn't infer). */
  knownUnknowns: KnownUnknown[];
  /** Local machine environment (milestone 4). Optional: absent if not detected. */
  machineEnv?: MachineEnv;
  /** Cross-repo flow map (milestone — prompt 34). Present for multi-repo workspaces. */
  flowMap?: FlowMap;
}

// ----- Multi-repo flow map (prompt 34) -----

/** A node in the flow map = a repo (or a service within it). */
export interface FlowNode {
  /** Stable id (repo name, or repo:service). */
  id: string;
  /** Display label. */
  label: string;
  /** The repo this node belongs to. */
  repo: string;
  kind: "repo" | "http" | "ws" | "frontend" | "worker" | "cli" | "external";
  /** Port if known (from a detected service). */
  port?: number;
}

/** A source-grounded, confidence-scored edge between two flow nodes. */
export interface FlowEdge {
  from: string; // node id
  to: string; // node id
  /** What signal implied the edge. */
  kind:
    | "shared-env-var"
    | "shared-package"
    | "shared-port"
    | "http-url"
    | "localhost-port"
    | "compose-service"
    | "shared-config-key";
  /** Human label, e.g. "shares env var DATABASE_URL". */
  label: string;
  confidence: Confidence;
  /** Source evidence for the edge (file:line / var name / port). */
  evidence: SourceRef[];
}

/** The cross-repo flow map. */
export interface FlowMap {
  generatedAt: number;
  scanVersion: string;
  targetPath: string;
  nodes: FlowNode[];
  edges: FlowEdge[];
  /** Gaps the flow map is honest about (what it couldn't infer). */
  knownUnknowns: KnownUnknown[];
}

// ----- Local environment awareness (milestone 4, 07-...md §2) -----

/** Result of probing for one tool/runtime. A detected tool is runtime-verified. */
export interface ToolCheck {
  name: string;
  available: boolean;
  /** Version string if the probe returned one (e.g. "v24.15.0"). */
  version?: string;
  /** The exact (read-only) command run to detect it — provenance. */
  probe: string;
  grounding: Grounding;
}

/**
 * The user's local machine environment, detected via SAFE read-only probes only
 * (07-...md §2). Separates detected facts (tools[]) from inferred facts (os/shell)
 * and from things that need confirmation (ports). Never installs anything.
 */
export interface MachineEnv {
  os: string; // "linux" | "darwin" | "win32"
  /** True if running under WSL (detected from the kernel string). */
  isWSL: boolean;
  shell: string | null;
  arch: string;
  tools: ToolCheck[];
  /** Port checks only run when explicitly confirmed; empty otherwise. */
  ports: PortCheck[];
  /** Grounding for the environment snapshot as a whole. */
  grounding: Grounding;
}

// ----- Persistent local environment profile (prompt 39) -----

/** Normalized OS variant the profile distinguishes (drives command compatibility). */
export type OsVariant = "wsl" | "windows" | "macos" | "linux" | "unknown";

/**
 * A PERSISTENT, host-side snapshot of the user's local machine (prompt 39) — the
 * thing that lets OpenClaw "remember if I set up WSL or use native Windows" across
 * sessions and across target projects. It wraps a detected `MachineEnv` (the safe
 * read-only probe results) with a normalized OS variant, optional working
 * directories, and USER OVERRIDES that survive a refresh. Stored in HOST storage,
 * never inside a target project.
 */
export interface EnvironmentProfile {
  version: 1;
  /** Normalized OS variant (wsl/windows/macos/linux) — the headline distinction. */
  osVariant: OsVariant;
  /** The detected machine environment (tools, shell, ports) — refreshed on demand. */
  machine: MachineEnv;
  /** Working directories the user cares about (e.g. where target projects live). */
  workingDirs: string[];
  /**
   * Explicit user overrides that win over detection and PERSIST across refreshes
   * (req #6 "manually set preferred shell/environment"). E.g. a user on native
   * Windows whose detection is ambiguous can pin osVariant: "windows".
   */
  overrides: {
    osVariant?: OsVariant;
    shell?: string;
    /** Preferred command style, e.g. "posix" | "powershell". */
    commandStyle?: string;
  };
  /** epoch ms the profile was last detected/refreshed. */
  refreshedAt: number;
  /** epoch ms the profile (incl. overrides) was last written. */
  updatedAt: number;
}

/** A port availability check (opt-in, requires confirmation — may touch the network). */
export interface PortCheck {
  port: number;
  /** "occupied" = something is listening; "free" = nothing; "unknown" = couldn't tell. */
  state: "occupied" | "free" | "unknown";
  grounding: Grounding;
}

/**
 * Setup compatibility for one repo, derived by intersecting the commands the repo
 * needs against the tools the machine actually has. Drives "don't suggest a
 * command whose tool is missing" (07-...md §2).
 */
export interface SetupCompatibility {
  repo: string;
  /** Tools the repo's commands reference that are present on this machine. */
  toolsPresent: string[];
  /** Tools referenced but NOT found — commands needing these are flagged. */
  toolsMissing: string[];
  notes: string[];
}

// ----- Scan-to-scan comparison (requirement 8) -----

/** One changed finding between two scans, identified by a stable key. */
export interface FindingDelta {
  /** Stable identity within a section, e.g. a script name or "METHOD path". */
  key: string;
  /** Which section it lives in (scripts, routes, envVars, ...). */
  section: string;
  change: "added" | "removed" | "changed";
  /** Human-readable before/after for the change. */
  before?: string;
  after?: string;
}

/** Per-repo diff between a previous and a current scan. */
export interface RepoDiff {
  name: string;
  /** Commit transition, if the repo moved. */
  commitBefore: string | null;
  commitAfter: string | null;
  branchBefore: string | null;
  branchAfter: string | null;
  deltas: FindingDelta[];
  /** Known-unknowns opened/closed between scans. */
  unknownsOpened: string[];
  unknownsResolved: string[];
}

/** Workspace-level diff: which repos changed and how. */
export interface WorkspaceDiff {
  prevGeneratedAt: number;
  nextGeneratedAt: number;
  reposAdded: string[];
  reposRemoved: string[];
  repoDiffs: RepoDiff[];
}

// ----- Command book (milestone 3, 07-command-and-setup-assistant.md) -----

/** The categories the command book groups by (07-...md §0). */
export type CommandCategory =
  | "install"
  | "setup"
  | "dev"
  | "build"
  | "test"
  | "lint"
  | "deploy"
  | "docker"
  | "database"
  | "inspect"
  | "uncategorized";

/**
 * One command book entry — a runnable command + full provenance. Every field the
 * milestone requires (text, source file+line/section, repo, confidence,
 * freshness, runtime-verified) is present and derived from a grounded finding.
 */
export interface CommandBookEntry {
  repo: string;
  category: CommandCategory;
  /** The command to run. */
  command: string;
  name: string;
  /** Source file the command was declared in. */
  sourceFile: string;
  /** Finer source locator (e.g. "package.json:scripts.test" or "Makefile:42"). */
  sourceLocator?: string;
  confidence: Confidence;
  freshness: FreshnessStatus;
  /** Whether this command has been executed/verified (always false in this MVP). */
  runtimeVerified: boolean;
  verification: Verification;
  // ----- safety / risk classification (prompt 31, shared with verify.ts) -----
  /** Safety class: safe to run automatically / needs confirmation / never auto-run. */
  safety: "safe-auto" | "confirm-required" | "blocked";
  /** True if the command is read-only/idempotent and safe to run without asking. */
  safeToRunAutomatically: boolean;
  /** True if running it requires explicit user confirmation. */
  confirmationRequired: boolean;
  /** True if it may modify the target project or local machine (install/build/migrate/etc.). */
  mayModify: boolean;
  /** One-line reason for the classification (shown to the user). */
  safetyReason: string;
  /** Environment assumptions the command makes (tools it needs, e.g. "uv", "docker"). */
  envAssumptions: string[];
}

/** The full command book across all repos, grouped + with the gaps it knows about. */
export interface CommandBook {
  generatedAt: number;
  scanVersion: string;
  entries: CommandBookEntry[];
  /** Onboarding gaps relevant to commands (missing test/deploy command, ambiguous, unvalidated). */
  gaps: KnownUnknown[];
}

// ----- Highlight-to-Explain (milestone, 06-highlight-to-explain.md) -----

/** What a future UI sends: a repo + path + line range it highlighted. */
export interface ExplainRequest {
  /** Repo name (as in the index) the selection belongs to. */
  repo: string;
  /** Repo-relative file path. */
  path: string;
  /** 1-based inclusive line range of the selection. */
  startLine: number;
  endLine: number;
  /** Optional: who's asking, so explanation depth can adapt (10-...md, G1r). */
  experienceLevel?: "new-to-repo" | "junior" | "mid" | "senior";
  /** Optional free-text question / user intent to focus the explanation. */
  intent?: string;
  /** Optional selected code text (UI may send it; resolution still reads the file). */
  selectedText?: string;
}

/** A symbol detected near/at the selection (heuristic, not a real parser). */
export interface SymbolHit {
  name: string;
  kind: "function" | "class" | "method" | "const" | "route" | "unknown";
  /** "file:line" where it was matched. */
  locator: string;
  signature?: string;
}

/** A likely caller/callee found by static text search (heuristic — capped confidence). */
export interface RefHit {
  /** The symbol name referenced. */
  name: string;
  /** "file:line" of the reference. */
  locator: string;
  /** The matched line text, trimmed (evidence). */
  snippet: string;
}

/** Related project-intelligence entities the selection touches. */
export interface RelatedIntel {
  routes: { method: string; pathPattern: string; locator: string }[];
  scripts: { name: string; command: string }[];
  envVars: string[];
  services: string[];
}

/**
 * The source-grounded explanation package returned for a highlighted selection
 * (06-...md §1). Structured enough for a future frontend to render; carries
 * confidence, freshness, known-unknowns, and a junior-friendly summary.
 */
export interface ExplainPackage {
  request: ExplainRequest;
  /** Junior-engineer-friendly prose summary of what the code appears to do. */
  explanation: string;
  /** The enclosing symbol if one was detected. */
  enclosingSymbol: SymbolHit | null;
  /** The module/service area the file likely belongs to (top dir / service). */
  moduleArea: string | null;
  /** Other symbols detected within/near the selection. */
  nearbySymbols: SymbolHit[];
  /** Likely callers found by static search (heuristic). */
  likelyCallers: RefHit[];
  /** Likely callees referenced inside the selection (heuristic). */
  likelyCallees: RefHit[];
  /** Indexed symbols whose definition falls inside the selected range. */
  symbolsInRange: SymbolHit[];
  /** Confidence-classified references to the enclosing symbol (call/import/mention). */
  references: SymbolReference[];
  /** Cross-repo flow edges touching this file's repo (inferred — prompt 34). */
  flowContext: { from: string; to: string; kind: string; label: string; confidence: Confidence }[];
  related: RelatedIntel;
  /** The raw selected lines (evidence; trimmed/capped). */
  selectedCode: string;
  /** Evidence: every file/symbol/scan fact this package rests on. */
  evidence: {
    sources: SourceRef[];
    scanGeneratedAt: number;
    scanVersion: string;
    baseCommit: string | null;
  };
  confidence: Confidence;
  freshness: FreshnessStatus;
  /** Set when the index may be outdated relative to the working tree. */
  staleWarning?: string;
  knownUnknowns: KnownUnknown[];
  /** Concrete next checks that would raise confidence (13-...md §7). */
  suggestedFollowups: string[];
  /**
   * The remembered presentation guidance applied to this explanation (prompt 36),
   * surfaced for transparency: which level + the exact guidance lines used. Absent
   * when no memory/preferences were supplied.
   */
  appliedGuidance?: { level: ExplainRequest["experienceLevel"]; lines: string[] };
  /**
   * The automatic context pack assembled for this explanation (prompt 37). Lets
   * highlight-to-explain ship the relevant project context WITHOUT the user
   * hand-attaching files. Absent when the caller didn't request a pack.
   */
  contextPack?: ContextPack;
  grounding: Grounding;
}

// ----- Change Confidence Report (08-change-confidence-impact-analysis.md) -----

/** A changed file + the intel entities it touches. */
export interface ChangedFile {
  path: string;
  /** git porcelain status code (e.g. " M", "A ", "??"). */
  status: string;
  /** Human-readable change kind. */
  changeKind: "added" | "modified" | "deleted" | "renamed" | "untracked" | "other";
  added?: number;
  deleted?: number;
  /** Whether this file is covered by the project intelligence index at all. */
  indexed: boolean;
  /** Intel entities grounded on this file (routes/scripts/env/deploy/docs/services). */
  affectedEntities: { kind: string; label: string; locator?: string; confidence: Confidence }[];
}

/** A recommended command/test to run before pushing (from the command book). */
export interface RecommendedCommand {
  repo: string;
  category: string;
  name: string;
  command: string;
  /** Why it's recommended (e.g. "test command for a repo with code changes"). */
  reason: string;
  runtimeVerified: boolean;
  /** Safety class from the command book (prompt 31). */
  safety?: "safe-auto" | "confirm-required" | "blocked";
  /** Whether running it may modify the target/machine. */
  mayModify?: boolean;
}

/** A symbol changed by the diff + where it's referenced (prompt 35, source-grounded). */
export interface AffectedSymbol {
  name: string;
  kind: string;
  /** "file:line" of the definition. */
  locator: string;
  /** Confidence-classified references (the blast radius — inferred). */
  references: { locator: string; kind: string; confidence: Confidence }[];
}

/** A cross-repo flow edge touching a changed repo (prompt 35, inferred). */
export interface FlowImpact {
  from: string;
  to: string;
  kind: string;
  label: string;
  confidence: Confidence;
}

/** Per-repo slice of the change confidence report. */
export interface RepoChangeReport {
  repo: string;
  branch: string | null;
  headCommit: string | null;
  isGitRepo: boolean;
  changedFiles: ChangedFile[];
  /** Counts by change kind, for the summary. */
  summary: { total: number; code: number; config: number; test: number; deploy: number; docs: number; other: number };
  /** Symbols defined in changed files + their references (the blast radius). */
  affectedSymbols: AffectedSymbol[];
  /** Cross-repo flow edges touching this repo (inferred — verify the other side). */
  flowImpact: FlowImpact[];
  recommendedCommands: RecommendedCommand[];
  /** Findings the report is confident about (directly evidenced). */
  highConfidenceNotes: string[];
  /** Inferred / heuristic observations. */
  inferredNotes: string[];
  knownUnknowns: KnownUnknown[];
  /** Artifacts (docs/index) that may go stale because of these changes. */
  staleWarnings: string[];
  /** Things the system explicitly cannot determine yet. */
  doNotKnowYet: string[];
  /** What the human should eyeball before pushing. */
  manualReview: string[];
  grounding: Grounding;
}

/** The cross-repo change confidence report (08-...md §6). */
export interface ChangeConfidenceReport {
  generatedAt: number;
  scanVersion: string;
  /** The target project path this report describes. */
  targetPath?: string;
  /** True if a project-intelligence scan was available to link against. */
  indexAvailable: boolean;
  repos: RepoChangeReport[];
  /** Overall: this MVP NEVER asserts "safe" — it states what was/wasn't verified. */
  verdict: string;
}

// ----- Safe Runtime Verification (13-...md §7, milestone) -----

/** How a check is classified for safety (13-...md §7 / 07-...md §0 runPolicy). */
export type CheckClassification = "safe-auto" | "confirm-required" | "blocked";

/** A single verification check the system knows how to run. */
export interface VerificationCheck {
  id: string;
  kind: "tool-version" | "deps-installed" | "env-file" | "port" | "safe-command" | "test-command";
  /** Human label. */
  label: string;
  /** The actual command (program + args) or a synthetic check id. */
  command?: string;
  classification: CheckClassification;
  /** Why it's classified this way (shown to the user). */
  reason: string;
}

/** The recorded outcome of running (or refusing) a verification check. */
export interface VerificationResult {
  checkId: string;
  kind: VerificationCheck["kind"];
  label: string;
  command?: string;
  classification: CheckClassification;
  repo?: string;
  /** Working directory the check ran in. */
  cwd?: string;
  /** "ran" = executed; "skipped" = confirm-required not confirmed; "blocked" = destructive/refused. */
  status: "ran" | "skipped" | "blocked";
  exitCode: number | null;
  /** Pass/fail derived from exitCode (null if not run). */
  passed: boolean | null;
  /** Trimmed/capped stdout+stderr summary. */
  outputSummary: string;
  /** epoch ms when the check ran (stamped at the edge). */
  ranAt: number;
  /** How this result moves confidence for related findings. */
  confidenceImpact: "raises" | "lowers" | "none";
  grounding: Grounding;
}

/** The persisted verification store (read by the command book + change report). */
export interface VerificationStore {
  generatedAt: number;
  scanVersion: string;
  results: VerificationResult[];
}

// ----- Symbol references & call inference (prompt 33) -----

/** Confidence that a textual hit is a real reference/call (never asserted as fact). */
export type RefConfidence = "high" | "medium" | "low";

/** One textual reference to a symbol, classified by how strongly it implies usage. */
export interface SymbolReference {
  /** "file:line" of the reference. */
  locator: string;
  /** Trimmed matched line (evidence). */
  snippet: string;
  /**
   * "definition" = the symbol's own declaration; "call" = `name(` (likely a call);
   * "import" = an import/require line; "mention" = bare textual occurrence.
   */
  kind: "definition" | "call" | "import" | "mention";
  confidence: RefConfidence;
}

/** Result of searching the target for references to one symbol. */
export interface ReferenceResult {
  symbol: string;
  /** All classified references found (capped). */
  references: SymbolReference[];
  /** Files searched (for transparency). */
  filesSearched: number;
  /** True if the search was truncated by the cap. */
  truncated: boolean;
}

// ----- Automatic Context Pack (prompt 37) -----

/**
 * What the user is trying to do — drives which context is RELEVANT so the pack
 * stays compact (req #1/#5). Each mode emphasizes a different slice of the index.
 */
export type ContextMode = "onboarding" | "explain" | "change-confidence" | "deployment" | "command-help";

/** The request that a context pack is built for (prompt 37 req #1). */
export interface ContextPackRequest {
  /** Target project id (path hash) — resolved by the caller; recorded for traceability. */
  projectId: string;
  /** The user's question / intent (free text). */
  question: string;
  /** Optional repo name to scope to (else inferred from filePath / whole workspace). */
  repo?: string;
  /** Optional repo-relative file path the question is about. */
  filePath?: string;
  /** Optional 1-based inclusive line range within filePath. */
  startLine?: number;
  endLine?: number;
  /** Optional selected code text (UI may send it; resolution still reads the file). */
  selectedCode?: string;
  /** What the user is doing; selects the relevance lens. Default: "explain". */
  mode?: ContextMode;
}

/**
 * One included context item. Every item is RELEVANCE-SCORED, SOURCE-GROUNDED, and
 * carries its own freshness/confidence so the LLM can hedge (req #2/#3/#4).
 */
export interface ContextItem {
  /** What kind of context this is (so a consumer can group/render). */
  kind:
    | "project-metadata"
    | "repo-summary"
    | "selected-code"
    | "nearby-code"
    | "symbol"
    | "reference"
    | "route"
    | "command"
    | "env-var"
    | "deploy-file"
    | "doc-file"
    | "flow-edge"
    | "known-unknown";
  /** Short human label. */
  label: string;
  /** The actual content (code snippet, summary line, command, etc.). */
  content: string;
  /** Why this item was selected (relevance rationale — transparency). */
  reason: string;
  /** Source references backing this item (req #3). */
  sources: SourceRef[];
  confidence: Confidence;
  freshness: FreshnessStatus;
  /** True if this item is known/likely stale or otherwise uncertain (req #4). */
  uncertain: boolean;
}

/**
 * The compact, automatically-assembled context pack (prompt 37). Replaces
 * hand-made attachment files: the user asks a question, OpenClaw gathers the
 * relevant source-grounded intelligence + their preferences and packages it.
 */
export interface ContextPack {
  /** Schema version so consumers can adapt. */
  version: 1;
  generatedAt: number;
  scanVersion: string;
  /** The resolved request. */
  request: ContextPackRequest;
  /** The target project path (recorded; never modified). */
  targetPath: string;
  mode: ContextMode;
  /** Bounded, relevance-ranked context items. */
  items: ContextItem[];
  /** The remembered presentation guidance (prompt 36) applied to this pack. */
  guidance: { level: ExplainRequest["experienceLevel"]; lines: string[] };
  /** Overall freshness verdict for the index this pack drew from. */
  freshness: FreshnessStatus;
  /** Overall confidence (the WORST of the included items — never over-claims). */
  confidence: Confidence;
  /** Things the pack is honest about NOT knowing (req #2). */
  knownUnknowns: KnownUnknown[];
  /** Transparency: how many candidate items existed vs. how many were included. */
  selection: { candidates: number; included: number; budget: number; droppedForBudget: number };
  /** A one-paragraph human-readable preamble the LLM can read first. */
  summary: string;
}

// ----- Deployment Explorer (09-...md, prompt 38) -----

/** The kind of deployment signal a file represents (09-...md §0/§1). */
export type DeploymentSignalType =
  | "dockerfile"
  | "compose"
  | "kubernetes"
  | "github-actions"
  | "gitlab-ci"
  | "jenkins"
  | "bitbucket-pipelines"
  | "cicd-config"
  | "package-script"
  | "makefile"
  | "deploy-script"
  | "env-example"
  | "readme-deploy"
  | "cloud-config";

/**
 * One detected deployment signal + everything extracted from it (prompt 38 req #2).
 * Source-grounded (every signal cites its file) and confidence/freshness-scored.
 */
export interface DeploymentSignal {
  /** Repo-relative source file the signal came from. */
  sourceFile: string;
  type: DeploymentSignalType;
  /** The repo (in a multi-repo workspace) this signal belongs to. */
  repo: string;
  /** Optional service/component name the signal targets (e.g. compose service). */
  service?: string;
  /** Build/run/deploy commands extracted from the signal (raw, never executed). */
  commands: string[];
  /** Env var NAMES referenced (never values — S6). */
  envVars: string[];
  /** Ports exposed/mapped, if detected. */
  ports: number[];
  /** Runtime/image/service dependencies named in the signal (e.g. base image, compose deps). */
  dependencies: string[];
  /** A one-line human summary of what the signal says. */
  summary: string;
  confidence: Confidence;
  freshness: FreshnessStatus;
  /** Source references (file / file:line). */
  sources: SourceRef[];
  /** What this signal does NOT tell us (e.g. "compose is test infra, not prod"). */
  knownUnknownIds: string[];
}

/** An inferred runtime dependency between a service and a peer (09-...md §2). Heuristic. */
export interface RuntimeDependency {
  /** The repo/service that has the dependency. */
  from: string;
  /** The dependency target (e.g. "postgres", "service-voice", an external API host). */
  to: string;
  kind: "datastore" | "internal-service" | "external-api" | "message-queue" | "unknown";
  /** How it was inferred (env var name, compose link, url). */
  via: string;
  /** Whether it looks required vs optional (heuristic). */
  required: boolean;
  confidence: Confidence;
  sources: SourceRef[];
}

/** The deployment picture for one repo within the workspace. */
export interface RepoDeployment {
  repo: string;
  /** One-line characterization of how this repo appears to deploy. */
  model: string;
  signals: DeploymentSignal[];
  /** Inferred runtime dependencies for this repo's services. */
  runtimeDependencies: RuntimeDependency[];
  /** Service boundaries (name + ports + kind) drawn from the index. */
  services: { name: string; kind: string; ports: number[]; evidence: string }[];
  /** Union of env var names across this repo's deployment signals. */
  requiredEnvVars: string[];
  /** Union of build/run/deploy commands across signals. */
  commands: { category: "build" | "run" | "deploy" | "other"; command: string; source: string }[];
  confidence: Confidence;
  freshness: FreshnessStatus;
  knownUnknowns: KnownUnknown[];
}

/**
 * The full deployment report for a (possibly multi-repo) target (prompt 38 §3).
 * Honest: separates source-grounded facts from inferred topology, and says when
 * production deployment is unknown. Read-only; never modifies the target.
 */
export interface DeploymentReport {
  version: 1;
  generatedAt: number;
  scanVersion: string;
  targetPath: string;
  /** Whether the index covers >1 repo. */
  multiRepo: boolean;
  /** Per-repo deployment pictures. */
  repos: RepoDeployment[];
  /** Cross-repo deployment coupling (multi-repo only) — inferred, never invented. */
  crossRepoLinks: {
    from: string;
    to: string;
    /** What suggested the link (shared env var / port / package / compose). */
    via: string;
    /** "runtime-coupled" = talk at runtime; "co-deployed" = ship together; "independent" = separate. */
    kind: "runtime-coupled" | "co-deployed" | "shared-config" | "independent";
    confidence: Confidence;
    sources: SourceRef[];
  }[];
  /** What's source-grounded (facts read directly from files). */
  sourceGrounded: string[];
  /** What's inferred (heuristic — runtime deps, coupling). */
  inferred: string[];
  /** What's unknown (esp. production topology — never fabricated). */
  unknown: string[];
  /** A Mermaid diagram of the deployment topology (empty string if too little evidence). */
  diagram: string;
  confidence: Confidence;
  freshness: FreshnessStatus;
  knownUnknowns: KnownUnknown[];
  /** One-paragraph human summary. */
  summary: string;
}

// ----- Target Project Dashboard (prompt 40) -----

/**
 * A compact, READ-ONLY aggregate of everything the dashboard needs about ONE
 * registered target project, assembled from the STORED index + registry + the
 * host environment profile. It runs nothing and modifies nothing — it just reads
 * what previous scans/reports already produced so the UI can show overview,
 * repo map, command summary, freshness, confidence, and known-unknowns in one
 * place (prompt 40 req #1–#3). Heavy artifacts (full change/deploy reports) are
 * generated on demand by their own actions, not embedded here.
 */
export interface TargetDashboard {
  version: 1;
  generatedAt: number;
  /** Whether a stored scan exists for this target (else most sections are empty). */
  scanned: boolean;
  /** Registry metadata for the target (id, name, path, repo type, last scan…). */
  project: {
    id: string;
    displayName: string;
    targetPath: string;
    repoType: "single-repo" | "multi-repo" | "unknown";
    repos: string[];
    lastScannedAt: number | null;
    storageDir: string;
    description?: string;
  };
  /** Overall freshness verdict (from the registry / stored grounding). */
  freshness: FreshnessStatus | "unknown";
  /** Confidence rollup across repos (worst-of, plus per-repo). */
  confidence: { overall: Confidence; perRepo: { repo: string; confidence: Confidence }[] };
  /** Known-unknowns rollup: total + by impact + a few representative titles. */
  knownUnknowns: { total: number; byImpact: { high: number; medium: number; low: number }; top: { title: string; detail: string; impact: Confidence }[] };
  /** Repo map: one row per repo (languages, counts, freshness, confidence). */
  repos: {
    name: string;
    languages: string[];
    gitBranch: string | null;
    gitCommit: string | null;
    scripts: number;
    routes: number;
    services: number;
    symbols: number;
    envVars: number;
    deployFiles: number;
    confidence: Confidence;
    freshness: FreshnessStatus;
    knownUnknowns: number;
  }[];
  /** Command-book summary (counts by category + a few representative commands). */
  commands: { total: number; byCategory: { category: string; count: number }[]; sample: { repo: string; category: string; name: string; command: string; safety: string }[] };
  /** Deployment signal summary (does NOT run the full explorer — just a peek). */
  deployment: { hasSignals: boolean; signalFiles: string[]; note: string };
  /** Local environment status (from the host profile), if one exists. */
  environment: { available: boolean; osVariant?: string; shell?: string | null; toolsPresent?: string[]; toolsMissing?: string[] } | null;
  /** A one-paragraph human summary the UI can show at the top. */
  summary: string;
}
