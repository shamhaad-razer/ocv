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
  languages: string[];
  coverage: ScanCoverage;
  importantDirs: Finding<string>[];
  packageFiles: Finding<string>[];
  /** README / docs files found (for "what is this repo?"). */
  docFiles: Finding<string>[];
  scripts: Finding<DetectedScript>[];
  services: Finding<DetectedService>[];
  routes: Finding<DetectedRoute>[];
  envFiles: Finding<string>[];
  envVars: Finding<DetectedEnvVar>[];
  deployFiles: Finding<string>[];
  knownUnknowns: KnownUnknown[];
  /** Grounding for the repo-level scan as a whole. */
  grounding: Grounding;
}

/** Workspace = the parent dir holding multiple repos. */
export interface WorkspaceIntel {
  rootPath: string;
  scanVersion: string;
  generatedAt: number;
  repos: RepoIntel[];
  /** Cross-repo edges are out of MVP scope; tracked as a known-unknown instead. */
  knownUnknowns: KnownUnknown[];
  /** Local machine environment (milestone 4). Optional: absent if not detected. */
  machineEnv?: MachineEnv;
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
  | "dev"
  | "build"
  | "test"
  | "lint"
  | "deploy"
  | "docker"
  | "database"
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
}

/** The full command book across all repos, grouped + with the gaps it knows about. */
export interface CommandBook {
  generatedAt: number;
  scanVersion: string;
  entries: CommandBookEntry[];
  /** Onboarding gaps relevant to commands (missing test/deploy command, ambiguous, unvalidated). */
  gaps: KnownUnknown[];
}
