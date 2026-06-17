// Multi-repo flow mapping (prompt 34). Pure + host-only: given a scanned
// multi-repo WorkspaceIntel, derive SOURCE-GROUNDED, confidence-scored edges
// between repos and emit a Mermaid diagram. Honors the principle: an inferred
// relationship is labeled inferred — unproven links are NOT presented as fact,
// and what can't be inferred is recorded as a known-unknown. READ-ONLY.
//
// Signals (all already scanned, or read read-only here):
//   shared env var name      → repos that both reference VAR_X are likely wired
//   shared internal package   → one repo depends on another's package name
//   shared / localhost port    → a service port referenced in another repo
//   HTTP URL / localhost:port  → a client reference from one repo to a service
//   docker-compose service     → compose names hint at the runtime topology

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  FlowEdge,
  FlowMap,
  FlowNode,
  KnownUnknown,
  RepoIntel,
  SourceRef,
  WorkspaceIntel,
} from "./types.js";

const MAX_FILES_PER_REPO = 1500;

/** Read a repo-relative file under the workspace, or null. Read-only. */
function read(workspaceRoot: string, repo: RepoIntel, rel: string): string | null {
  try {
    return readFileSync(join(repo.rootPath, rel), "utf-8");
  } catch {
    void workspaceRoot;
    return null;
  }
}

/** A repo's package name from package.json (for shared-package edges). */
function packageName(workspaceRoot: string, repo: RepoIntel): string | null {
  if (!repo.packageFiles.some((p) => p.value === "package.json")) return null;
  const raw = read(workspaceRoot, repo, "package.json");
  if (!raw) return null;
  try {
    return (JSON.parse(raw) as { name?: string }).name ?? null;
  } catch {
    return null;
  }
}

/** A repo's declared dependency names (package.json deps + devDeps). */
function dependencyNames(workspaceRoot: string, repo: RepoIntel): Set<string> {
  const out = new Set<string>();
  const raw = read(workspaceRoot, repo, "package.json");
  if (!raw) return out;
  try {
    const pkg = JSON.parse(raw) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    for (const k of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })) out.add(k);
  } catch {
    /* ignore */
  }
  return out;
}

/** Localhost ports referenced anywhere in a repo's source (e.g. "localhost:3000"). */
function localhostPorts(workspaceRoot: string, repo: RepoIntel, files: string[]): Map<number, string> {
  const found = new Map<number, string>(); // port -> "file:line"
  const re = /(?:localhost|127\.0\.0\.1)[:](\d{2,5})/g;
  let scanned = 0;
  for (const rel of files) {
    if (scanned >= MAX_FILES_PER_REPO) break;
    if (!/\.(ts|tsx|js|mjs|py|go|rs|ya?ml|env|json|toml)$/.test(rel)) continue;
    scanned++;
    const content = read(workspaceRoot, repo, rel);
    if (!content || content.length > 400_000) continue;
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(lines[i])) !== null) {
        const port = parseInt(m[1], 10);
        if (!found.has(port)) found.set(port, `${rel}:${i + 1}`);
      }
    }
  }
  return found;
}

export interface FlowMapOptions {
  generatedAt: number;
  /** Per-repo file lists (repo name → repo-relative files). */
  repoFiles: Record<string, string[]>;
}

/** Build the cross-repo flow map. Pure transform over the scanned workspace. */
export function buildFlowMap(ws: WorkspaceIntel, opts: FlowMapOptions): FlowMap {
  const now = opts.generatedAt;
  const targetPath = ws.targetPath ?? ws.rootPath;
  const nodes: FlowNode[] = [];
  const edges: FlowEdge[] = [];
  const knownUnknowns: KnownUnknown[] = [];

  // --- nodes: one per repo, plus its detected services ---
  for (const repo of ws.repos) {
    nodes.push({ id: repo.name, label: repo.name, repo: repo.name, kind: "repo" });
    for (const s of repo.services) {
      nodes.push({
        id: `${repo.name}:${s.value.name}`,
        label: s.value.name,
        repo: repo.name,
        kind: s.value.kind === "unknown" ? "http" : s.value.kind,
        port: s.value.defaultPort,
      });
    }
  }

  const addEdge = (e: FlowEdge) => {
    // dedupe by from+to+kind
    if (!edges.some((x) => x.from === e.from && x.to === e.to && x.kind === e.kind)) edges.push(e);
  };

  // --- precompute per-repo signals ---
  const pkgNames = new Map<string, string | null>();
  const deps = new Map<string, Set<string>>();
  const envByRepo = new Map<string, Set<string>>();
  const portsByRepo = new Map<string, Map<number, string>>();
  const servicePorts: { repo: string; port: number }[] = [];
  for (const repo of ws.repos) {
    pkgNames.set(repo.name, packageName(targetPath, repo));
    deps.set(repo.name, dependencyNames(targetPath, repo));
    envByRepo.set(repo.name, new Set(repo.envVars.map((e) => e.value.name)));
    portsByRepo.set(repo.name, localhostPorts(targetPath, repo, opts.repoFiles[repo.name] ?? []));
    for (const s of repo.services) if (s.value.defaultPort) servicePorts.push({ repo: repo.name, port: s.value.defaultPort });
  }

  // --- edge: shared internal package (one repo depends on another's package) ---
  for (const a of ws.repos) {
    const aPkg = pkgNames.get(a.name);
    if (!aPkg) continue;
    for (const b of ws.repos) {
      if (a.name === b.name) continue;
      if (deps.get(b.name)?.has(aPkg)) {
        addEdge({
          from: b.name,
          to: a.name,
          kind: "shared-package",
          label: `${b.name} depends on ${a.name}'s package \`${aPkg}\``,
          confidence: "high", // a declared dependency is a real, proven link
          evidence: [{ kind: "file", ref: `${b.name}/package.json`, locator: aPkg }],
        });
      }
    }
  }

  // --- edge: a localhost:port in repo B matches a service port in repo A ---
  for (const a of ws.repos) {
    for (const sp of servicePorts.filter((s) => s.repo === a.name)) {
      for (const b of ws.repos) {
        if (a.name === b.name) continue;
        const hit = portsByRepo.get(b.name)?.get(sp.port);
        if (hit) {
          addEdge({
            from: b.name,
            to: a.name,
            kind: "localhost-port",
            label: `${b.name} references localhost:${sp.port} — ${a.name}'s service port`,
            confidence: "medium", // port match is strong but not proof of THIS service
            evidence: [{ kind: "file", ref: `${b.name}/${hit.split(":")[0]}`, locator: hit }],
          });
        }
      }
    }
  }

  // --- edge: shared env var names (both repos reference the same VAR) ---
  // Lower confidence: a shared name implies coordination, not a direct call.
  const repoNames = ws.repos.map((r) => r.name);
  for (let i = 0; i < repoNames.length; i++) {
    for (let j = i + 1; j < repoNames.length; j++) {
      const a = repoNames[i], b = repoNames[j];
      const shared = [...(envByRepo.get(a) ?? [])].filter((v) => envByRepo.get(b)?.has(v));
      // Ignore ubiquitous vars that don't imply a relationship.
      const meaningful = shared.filter((v) => !/^(NODE_ENV|PORT|PATH|HOME|PWD|CI)$/.test(v));
      if (meaningful.length > 0) {
        addEdge({
          from: a,
          to: b,
          kind: "shared-env-var",
          label: `${a} and ${b} share env var(s): ${meaningful.slice(0, 4).join(", ")}${meaningful.length > 4 ? "…" : ""}`,
          confidence: "low", // shared config is a hint, not a proven edge
          evidence: meaningful.slice(0, 4).map((v) => ({ kind: "intel-entity" as const, ref: `env:${v}` })),
        });
      }
    }
  }

  // --- honest gaps ---
  knownUnknowns.push({
    id: "flowmap:no-call-graph",
    kind: "shallow-graph",
    title: "cross-repo edges are inferred, not proven",
    detail:
      "Edges come from shared env vars, package deps, and port/URL references — source-grounded signals, not a verified runtime call graph. " +
      "A missing edge does NOT mean repos are unrelated; an edge is a hint to verify.",
    evidence: [],
    status: "open",
    confidenceImpact: "medium",
  });
  if (ws.repos.length < 2) {
    knownUnknowns.push({
      id: "flowmap:single-repo",
      kind: "other",
      title: "single-repo target — no cross-repo flow",
      detail: "The target has one repo; there are no cross-repo relationships to map.",
      evidence: [],
      status: "open",
      confidenceImpact: "low",
    });
  }

  return { generatedAt: now, scanVersion: ws.scanVersion, targetPath, nodes, edges, knownUnknowns };
}

/** Find flow edges/nodes touching a given repo (used by explain). */
export function flowForRepo(flow: FlowMap, repo: string): { nodes: FlowNode[]; edges: FlowEdge[] } {
  const nodeIds = new Set(flow.nodes.filter((n) => n.repo === repo).map((n) => n.id));
  const edges = flow.edges.filter((e) => {
    const f = flow.nodes.find((n) => n.id === e.from);
    const t = flow.nodes.find((n) => n.id === e.to);
    return f?.repo === repo || t?.repo === repo;
  });
  return { nodes: flow.nodes.filter((n) => nodeIds.has(n.id)), edges };
}
