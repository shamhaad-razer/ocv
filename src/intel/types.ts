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
    | "other";
  title: string;
  detail: string;
  evidence: SourceRef[];
  status: "open" | "mitigated" | "resolved" | "reopened";
  /** How much this gap caps confidence of nearby findings. */
  confidenceImpact: Confidence;
}

/** Per-repo intelligence: the grounded map of one repository. */
export interface RepoIntel {
  name: string;
  rootPath: string;
  gitBranch: string | null;
  gitCommit: string | null;
  isGitRepo: boolean;
  languages: string[];
  importantDirs: Finding<string>[];
  packageFiles: Finding<string>[];
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
}
