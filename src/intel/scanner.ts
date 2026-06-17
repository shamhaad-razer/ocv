// Core repo scanner — onboarding engine Pass 1 (inventory) + Pass 2 (manifests),
// the cheap-but-high-value passes (05-onboarding-engine.md §1). Pure and
// host-independent; only node builtins + the grounding helpers.
//
// Every detected item becomes a Finding<T> with a Grounding block citing the
// source file(s) it came from. Where the scanner CANNOT confirm something, it
// records a KnownUnknown rather than guessing (13-...md §6, §11).

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import {
  basisForDeclared,
  buildGrounding,
  hashContent,
  hashFile,
  readGitInfo,
} from "./grounding.js";
import type {
  DetectedEnvVar,
  DetectedRoute,
  DetectedScript,
  DetectedService,
  Finding,
  Grounding,
  KnownUnknown,
  RepoIntel,
  SourceRef,
} from "./types.js";

/** Directories never worth scanning. Keeps the walk cheap + avoids vendored noise. */
const IGNORE_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  ".venv",
  "venv",
  "__pycache__",
  ".turbo",
  "coverage",
  ".pytest_cache",
  "dist-scan",
]);

/** Manifest/config files we know how to reason about (Pass 2). */
const PACKAGE_FILE_NAMES = new Set([
  "package.json",
  "pyproject.toml",
  "requirements.txt",
  "uv.lock",
  "poetry.lock",
  "Makefile",
  "Justfile",
  "go.mod",
  "Cargo.toml",
  "tsconfig.json",
  "next.config.ts",
  "next.config.js",
  "vitest.config.ts",
  "pytest.ini",
  "setup.cfg",
]);

const DOCKER_DEPLOY_PATTERNS = [
  /^Dockerfile$/i,
  /^docker-compose.*\.ya?ml$/i,
  /^bitbucket-pipelines\.ya?ml$/i,
  /\.gitlab-ci\.ya?ml$/i,
];

const ENV_FILE_PATTERNS = [/^\.env(\..+)?$/, /^\.env\.example$/, /^\.env\.template$/];

export interface ScanOptions {
  /** Injected at the edge so the pure scan stays deterministic. */
  generatedAt: number;
  /** Cap on files walked, a safety bound for huge trees. */
  maxFiles?: number;
}

interface WalkResult {
  files: string[]; // repo-relative paths
  dirs: string[]; // top-level dirs (repo-relative)
  skippedDirs: string[]; // top-level dir names skipped by ignore rules
  truncated: boolean;
}

/** Shallow-ish recursive walk, ignoring vendored dirs, bounded by maxFiles. */
function walkRepo(root: string, maxFiles: number): WalkResult {
  const files: string[] = [];
  const topDirs = new Set<string>();
  const skipped = new Set<string>();
  let truncated = false;

  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      const abs = join(dir, name);
      let isDir: boolean;
      try {
        isDir = statSync(abs).isDirectory();
      } catch {
        continue;
      }
      const rel = relative(root, abs);
      if (isDir) {
        if (IGNORE_DIRS.has(name)) {
          if (!rel.includes("/")) skipped.add(name); // record top-level skips
          continue;
        }
        if (!rel.includes("/")) topDirs.add(rel); // top-level only
        stack.push(abs);
      } else {
        if (files.length >= maxFiles) {
          truncated = true;
          continue;
        }
        files.push(rel);
      }
    }
  }
  return { files, dirs: [...topDirs].sort(), skippedDirs: [...skipped].sort(), truncated };
}

function fileSource(root: string, rel: string): SourceRef {
  return { kind: "file", ref: rel, hash: hashFile(join(root, rel)) ?? undefined };
}

/** Categorize a script by name/command for the command-book (07-...md §0). */
function categorizeScript(name: string, command: string): DetectedScript["category"] {
  const hay = `${name} ${command}`.toLowerCase();
  if (/\b(install|ci|bootstrap)\b/.test(hay) || /\b(npm|pnpm|yarn) (ci|install)\b/.test(hay)) return "install";
  if (/\b(test|pytest|vitest|jest)\b/.test(hay)) return "test";
  if (/\b(lint|eslint|ruff|flake8|prettier)\b/.test(hay)) return "lint";
  if (/\b(build|tsc|compile|bundle)\b/.test(hay)) return "build";
  if (/\b(dev|serve|start|run)\b/.test(hay)) return "dev-server";
  if (/\b(deploy|publish|release)\b/.test(hay)) return "deploy";
  if (/\bdocker\b/.test(hay)) return "docker";
  if (/\b(migrate|migration|seed|db)\b/.test(hay)) return "database";
  if (/\b(setup|init|prepare)\b/.test(hay)) return "setup";
  return "other";
}

function parsePackageJsonScripts(
  root: string,
  rel: string,
  grounding: (q: SourceRef) => Grounding,
): Finding<DetectedScript>[] {
  const out: Finding<DetectedScript>[] = [];
  try {
    const pkg = JSON.parse(readFileSync(join(root, rel), "utf-8")) as {
      scripts?: Record<string, string>;
    };
    for (const [name, command] of Object.entries(pkg.scripts ?? {})) {
      out.push({
        value: { name, command, source: rel, category: categorizeScript(name, command) },
        grounding: grounding({ kind: "file", ref: rel, locator: `scripts.${name}`, hash: hashFile(join(root, rel)) ?? undefined }),
      });
    }
  } catch {
    // unreadable/invalid — caller may record a known-unknown
  }
  return out;
}

/** Extract `target:` lines from a Makefile as commands (declared facts). */
function parseMakefileTargets(
  root: string,
  rel: string,
  grounding: (q: SourceRef) => Grounding,
): Finding<DetectedScript>[] {
  const out: Finding<DetectedScript>[] = [];
  try {
    const lines = readFileSync(join(root, rel), "utf-8").split(/\r?\n/);
    const hash = hashFile(join(root, rel)) ?? undefined;
    lines.forEach((line, i) => {
      const m = /^([a-zA-Z0-9_.-]+):(?!=)/.exec(line);
      if (m && !line.startsWith("\t")) {
        const name = m[1];
        out.push({
          value: { name, command: `make ${name}`, source: rel, category: categorizeScript(name, name) },
          grounding: grounding({ kind: "file", ref: rel, locator: `${rel}:${i + 1}`, hash }),
        });
      }
    });
  } catch {
    /* ignore */
  }
  return out;
}

/** Heuristic env-var name extraction from a .env-style file (NAMES only, no values — S6). */
function parseEnvVarNames(root: string, rel: string): string[] {
  const names: string[] = [];
  try {
    for (const line of readFileSync(join(root, rel), "utf-8").split(/\r?\n/)) {
      const m = /^\s*([A-Z][A-Z0-9_]+)\s*=/.exec(line);
      if (m) names.push(m[1]);
    }
  } catch {
    /* ignore */
  }
  return names;
}

/**
 * Heuristic route detection for the obvious cases only (05-...md §4). We DO NOT
 * pretend to a full route table — anything found here is analysisQuality
 * "heuristic" (=> capped at medium confidence), and the absence of a deep parse
 * is itself recorded as a shallow-graph known-unknown.
 */
function detectRoutes(root: string, files: string[]): Finding<DetectedRoute>[] {
  const out: Finding<DetectedRoute>[] = [];
  // Require the path argument to START WITH "/" — this excludes the many false
  // positives from Map.get()/headers.get()/flags.get() etc. that aren't routes.
  // Heuristic, not exhaustive: better to under-report (and flag the gap as a
  // known-unknown) than to assert non-routes as routes (honesty over recall).
  const patterns: { re: RegExp; method: (m: RegExpMatchArray) => string }[] = [
    // FastAPI / Starlette decorators: @app.get("/x"), @router.websocket("/y")
    { re: /@\w+\.(get|post|put|delete|patch|websocket)\(\s*["'`](\/[^"'`]*)["'`]/g, method: (m) => m[1].toUpperCase() },
    // Express/relay-ish: app.get("/x"  / router.post('/y'
    { re: /\b(?:app|router|server|api)\.(get|post|put|delete|patch|ws|use)\(\s*["'`](\/[^"'`]*)["'`]/g, method: (m) => m[1].toUpperCase() },
  ];
  const candidates = files.filter((f) => /\.(py|ts|js|mjs)$/.test(f) && !f.includes("__tests__") && !f.includes("/tests/"));
  // Dedupe: a decorator like @app.post("/tts") matches both patterns; the same
  // route should appear once per (method, path, locator).
  const seen = new Set<string>();
  for (const rel of candidates) {
    let content: string;
    try {
      content = readFileSync(join(root, rel), "utf-8");
    } catch {
      continue;
    }
    if (content.length > 400_000) continue; // skip huge/generated files
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      for (const { re, method } of patterns) {
        re.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = re.exec(lines[i])) !== null) {
          const meth = method(m);
          const key = `${meth} ${m[2]} ${rel}:${i + 1}`;
          if (seen.has(key)) continue;
          seen.add(key);
          out.push({
            value: { method: meth, pathPattern: m[2], locator: `${rel}:${i + 1}` },
            grounding: groundingForRoute(rel, `${rel}:${i + 1}`, hashContent(content)),
          });
        }
      }
    }
  }
  return out;
}

// Standalone grounding for routes (heuristic quality) — defined here to keep
// detectRoutes self-contained; generatedAt/baseCommit are patched in by scanRepo.
let _routeCtx: { generatedAt: number; baseCommit: string | null } = { generatedAt: 0, baseCommit: null };
function groundingForRoute(rel: string, locator: string, hash: string): Grounding {
  return buildGrounding({
    generatedAt: _routeCtx.generatedAt,
    baseCommit: _routeCtx.baseCommit,
    sources: [{ kind: "file", ref: rel, locator, hash }],
    analysisQuality: "heuristic",
  });
}

type Quality = "declared" | "parsed" | "heuristic" | "inferred";

/** Infer services from well-known signals (declared where possible). */
function detectServices(root: string, files: string[], mkG: (s: SourceRef[], q: Quality) => Grounding): Finding<DetectedService>[] {
  const out: Finding<DetectedService>[] = [];
  const has = (p: string) => files.includes(p);

  if (has("next.config.ts") || has("next.config.js")) {
    out.push({
      value: { name: "next-frontend", kind: "frontend", evidence: "next.config", defaultPort: 3000 },
      grounding: mkG([fileSource(root, has("next.config.ts") ? "next.config.ts" : "next.config.js")], "declared"),
    });
  }
  // FastAPI / pipecat style python entrypoint
  const pyEntry = files.find((f) => /(^|\/)(bot|main|app|server)\.py$/.test(f));
  if (pyEntry) {
    out.push({
      value: { name: pyEntry.replace(/\//g, ":"), kind: "http", evidence: pyEntry },
      grounding: mkG([fileSource(root, pyEntry)], "heuristic"),
    });
  }
  // Node server entry
  const nodeEntry = files.find((f) => /(^|\/)server\/index\.ts$/.test(f) || /(^|\/)src\/server\.ts$/.test(f));
  if (nodeEntry) {
    out.push({
      value: { name: nodeEntry.replace(/\//g, ":"), kind: "http", evidence: nodeEntry },
      grounding: mkG([fileSource(root, nodeEntry)], "heuristic"),
    });
  }
  return out;
}

export function scanRepo(repoRoot: string, opts: ScanOptions): RepoIntel {
  const generatedAt = opts.generatedAt;
  const maxFiles = opts.maxFiles ?? 5000;
  const git = readGitInfo(repoRoot);
  const baseCommit = git.commit;
  _routeCtx = { generatedAt, baseCommit };

  const name = repoRoot.split("/").filter(Boolean).pop() ?? repoRoot;
  const { files, dirs, skippedDirs, truncated } = walkRepo(repoRoot, maxFiles);
  const coverage = { filesScanned: files.length, dirsScanned: dirs, dirsSkipped: skippedDirs, truncated, maxFiles };

  const knownUnknowns: KnownUnknown[] = [];
  const addUnknown = (u: Omit<KnownUnknown, "id"> & { id?: string }): string => {
    const id = u.id ?? `${name}:unknown:${knownUnknowns.length + 1}`;
    knownUnknowns.push({ ...u, id });
    return id;
  };

  // Grounding factory bound to this repo's commit + time.
  const ground = (sources: SourceRef[], quality: "declared" | "parsed" | "heuristic" | "inferred", knownUnknownIds?: string[]): Grounding =>
    buildGrounding({ generatedAt, baseCommit, sources, analysisQuality: quality, knownUnknownIds });

  // --- languages (from extensions present) ---
  const langSet = new Set<string>();
  for (const f of files) {
    if (f.endsWith(".ts") || f.endsWith(".tsx")) langSet.add("typescript");
    else if (f.endsWith(".js") || f.endsWith(".mjs")) langSet.add("javascript");
    else if (f.endsWith(".py")) langSet.add("python");
    else if (f.endsWith(".go")) langSet.add("go");
    else if (f.endsWith(".rs")) langSet.add("rust");
  }

  // --- important directories (top-level, declared by presence) ---
  const importantDirs: Finding<string>[] = dirs.map((d) => ({
    value: d,
    grounding: ground([{ kind: "dir", ref: d }], "declared"),
  }));

  // --- package/config files ---
  const packageFiles: Finding<string>[] = files
    .filter((f) => PACKAGE_FILE_NAMES.has(f.split("/").pop() as string))
    .map((f) => ({ value: f, grounding: ground([fileSource(repoRoot, f)], "declared") }));

  // --- doc files (README + docs/) for "what is this repo?" ---
  const docFiles: Finding<string>[] = files
    .filter((f) => /(^|\/)readme(\.md|\.txt|\.rst)?$/i.test(f) || /(^|\/)docs\//.test(f))
    .map((f) => ({ value: f, grounding: ground([fileSource(repoRoot, f)], "declared") }));
  const hasReadme = docFiles.some((d) => /(^|\/)readme/i.test(d.value));
  if (!hasReadme) {
    addUnknown({
      kind: "missing-readme",
      title: "no README found",
      detail: "No README at scan time; the repo's purpose can't be grounded in prose and must be inferred from structure.",
      evidence: [],
      status: "open",
      confidenceImpact: "medium",
    });
  }

  // --- scripts/commands ---
  const scripts: Finding<DetectedScript>[] = [];
  for (const f of files) {
    const base = f.split("/").pop();
    if (base === "package.json") {
      scripts.push(...parsePackageJsonScripts(repoRoot, f, (q) => ground([q], "declared")));
    } else if (base === "Makefile" || base === "Justfile") {
      scripts.push(...parseMakefileTargets(repoRoot, f, (q) => ground([q], "declared")));
    }
  }
  if (scripts.length === 0) {
    addUnknown({
      kind: "unvalidated-command",
      title: "no declared scripts found",
      detail: "No package.json scripts or Makefile targets detected; run commands may live only in README/docs.",
      evidence: [],
      status: "open",
      confidenceImpact: "medium",
    });
  } else {
    // Commands are detected but never run here — flag that they're unvalidated.
    addUnknown({
      kind: "unvalidated-command",
      title: "commands detected but not validated",
      detail: "Scripts were read from manifests but not executed; success/failure is unverified until runtime verification (milestone 10).",
      evidence: scripts.slice(0, 3).map((s) => ({ kind: "file" as const, ref: s.value.source, locator: s.value.name })),
      status: "open",
      confidenceImpact: "low",
    });
  }
  // Onboarding gaps: a missing test command is a real obstacle for a new engineer.
  if (!scripts.some((s) => s.value.category === "test")) {
    addUnknown({
      kind: "missing-test-command",
      title: "no test command detected",
      detail: "No declared script categorized as `test`. How to test this repo is unknown from manifests (may live in CI or docs).",
      evidence: [],
      status: "open",
      confidenceImpact: "medium",
    });
  }

  // --- env files + var names ---
  const envFiles: Finding<string>[] = files
    .filter((f) => ENV_FILE_PATTERNS.some((re) => re.test(f.split("/").pop() as string)))
    .map((f) => ({ value: f, grounding: ground([fileSource(repoRoot, f)], "declared") }));

  const envVars: Finding<DetectedEnvVar>[] = [];
  for (const ef of envFiles) {
    // Only read .example/.template (committed); never read a real .env's values.
    if (!/\.(example|template)$/.test(ef.value)) continue;
    for (const varName of parseEnvVarNames(repoRoot, ef.value)) {
      envVars.push({
        value: { name: varName, source: ef.value },
        grounding: ground([{ kind: "file", ref: ef.value, locator: varName, hash: hashFile(join(repoRoot, ef.value)) ?? undefined }], "declared"),
      });
    }
  }
  // Onboarding gap: a real .env exists but no committed .example/.template to
  // tell a new engineer which vars to set (and we never read the real values, S6).
  const hasRealEnv = envFiles.some((e) => /(^|\/)\.env$/.test(e.value));
  const hasEnvExample = envFiles.some((e) => /\.(example|template)$/.test(e.value));
  if (hasRealEnv && !hasEnvExample) {
    addUnknown({
      kind: "missing-env-example",
      title: "no committed env example",
      detail: "A .env exists but no .env.example/.template — required env vars can't be listed for onboarding (values are never read, S6).",
      evidence: envFiles.filter((e) => /(^|\/)\.env$/.test(e.value)).map((e) => ({ kind: "file" as const, ref: e.value })),
      status: "open",
      confidenceImpact: "medium",
    });
  }

  // --- docker / deployment files ---
  const deployFiles: Finding<string>[] = files
    .filter((f) => DOCKER_DEPLOY_PATTERNS.some((re) => re.test(f.split("/").pop() as string)))
    .map((f) => ({ value: f, grounding: ground([fileSource(repoRoot, f)], "declared") }));
  // also catch cicd/ directory configs
  const cicdConfigs = files.filter((f) => /(^|\/)cicd\/.*\.(ya?ml)$/.test(f));
  for (const f of cicdConfigs) {
    deployFiles.push({ value: f, grounding: ground([fileSource(repoRoot, f)], "declared") });
  }
  if (deployFiles.length === 0) {
    addUnknown({
      kind: "missing-deploy-config",
      title: "no deployment config detected",
      detail: "No Dockerfile, compose, CI pipeline, or cicd/ config found at scan time. Deployment strategy is unknown from source.",
      evidence: [],
      status: "open",
      confidenceImpact: "high",
    });
  }

  // --- services ---
  const services = detectServices(repoRoot, files, (s, q) => ground(s, q));

  // --- routes (heuristic) ---
  const routes = detectRoutes(repoRoot, files);
  // Always record that the call graph is shallow — we did NOT build one.
  addUnknown({
    kind: "shallow-graph",
    title: "no call graph built",
    detail: "Routes (if any) are detected by regex heuristics; callers/callees and end-to-end flows are not yet indexed (milestone 4).",
    evidence: routes.slice(0, 3).map((r) => ({ kind: "file" as const, ref: r.value.locator })),
    status: "open",
    confidenceImpact: "medium",
  });

  if (truncated) {
    addUnknown({
      kind: "other",
      title: "scan truncated",
      detail: `File walk hit the ${maxFiles}-file cap; some files were not inventoried.`,
      evidence: [],
      status: "open",
      confidenceImpact: "medium",
    });
  }

  if (!git.isGitRepo) {
    addUnknown({
      kind: "other",
      title: "not a git repository",
      detail: "Could not read git branch/commit; freshness cannot be anchored to a commit hash.",
      evidence: [],
      status: "open",
      confidenceImpact: "medium",
    });
  }

  // Repo-level grounding: cite the manifests we leaned on most.
  const repoGrounding = ground(
    packageFiles.map((p) => ({ kind: "file" as const, ref: p.value, hash: p.grounding.fileHashes[0]?.hash })),
    "declared",
    knownUnknowns.map((u) => u.id),
  );

  return {
    name,
    rootPath: repoRoot,
    gitBranch: git.branch,
    gitCommit: git.commit,
    isGitRepo: git.isGitRepo,
    gitDirty: git.dirty,
    languages: [...langSet].sort(),
    coverage,
    importantDirs,
    packageFiles,
    docFiles,
    scripts,
    services,
    routes,
    envFiles,
    envVars,
    deployFiles,
    knownUnknowns,
    grounding: repoGrounding,
  };
}
