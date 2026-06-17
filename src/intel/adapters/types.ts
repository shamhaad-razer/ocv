// Pluggable language/framework adapter layer (prompt 30).
//
// The core scanner owns generic, language-agnostic concerns (file walk, env
// files, docker/deploy, docs, language tags). Everything LANGUAGE/FRAMEWORK
// specific — how commands, routes, and services are discovered — lives in
// adapters behind this interface, so breadth grows without hardcoding more
// assumptions into the scanner. Adapters fail safe: if one doesn't recognize a
// repo it simply doesn't `appliesTo` it, and the generic fallback records a
// known-unknown rather than pretending understanding.

import type {
  DetectedRoute,
  DetectedScript,
  DetectedService,
  DetectedSymbol,
  Finding,
  Grounding,
  KnownUnknown,
  SourceRef,
} from "../types.js";

export type Quality = "declared" | "parsed" | "heuristic" | "inferred";

/** Read-only context handed to every adapter. No adapter writes to the target. */
export interface AdapterContext {
  /** Absolute target/repo root. */
  repoRoot: string;
  /** Repo-relative file paths (already inventoried + ignore-filtered). */
  files: string[];
  /** True if `rel` exists in `files`. */
  has: (rel: string) => boolean;
  /** Read a repo-relative file's text, or null. Read-only. */
  read: (rel: string) => string | null;
  /** Build a SourceRef for a repo-relative file (with content hash). */
  fileSource: (rel: string) => SourceRef;
  /** Build a grounding block for some sources at a given analysis quality. */
  ground: (sources: SourceRef[], quality: Quality) => Grounding;
}

/** What an adapter contributes about a repo. All arrays default to empty. */
export interface AdapterResult {
  /** Adapter id (e.g. "node", "python", "generic"). */
  adapter: string;
  /** Detected runnable commands. */
  scripts: Finding<DetectedScript>[];
  /** Detected HTTP/WS routes (heuristic). */
  routes: Finding<DetectedRoute>[];
  /** Detected runnable/deployable services. */
  services: Finding<DetectedService>[];
  /** Symbols extracted from source (functions/classes/exports). */
  symbols: Finding<DetectedSymbol>[];
  /** Gaps THIS adapter is honest about (e.g. "scripts not parsed for lang X"). */
  knownUnknowns: KnownUnknown[];
  /** Source files that support this adapter's detections (for traceability). */
  evidence: SourceRef[];
  /** Best analysis quality this adapter achieved (drives confidence). */
  quality: Quality;
  /** Whether the detected commands could be runtime-verified (e.g. a known runner exists). */
  runtimeVerifiable: boolean;
}

/** A language/framework adapter. */
export interface Adapter {
  /** Stable id. */
  id: string;
  /** One-line description (for docs/reporting). */
  description: string;
  /** Cheap test: does this adapter apply to the repo? (e.g. manifest present) */
  appliesTo: (ctx: AdapterContext) => boolean;
  /** Run the adapter; only called when appliesTo is true. */
  detect: (ctx: AdapterContext) => AdapterResult;
}

/** Helper: an empty result an adapter can spread into. */
export function emptyResult(adapter: string, quality: Quality = "declared", runtimeVerifiable = false): AdapterResult {
  return { adapter, scripts: [], routes: [], services: [], symbols: [], knownUnknowns: [], evidence: [], quality, runtimeVerifiable };
}

/**
 * Shared symbol extraction over source files matching `exts`. Heuristic (regex,
 * not a parser) — honest: emitted symbols are "parsed" quality (we DID read the
 * declaration line) but caller/callee relationships are NOT proven here. Captures
 * functions, classes, methods, and exported consts across TS/JS/Python shapes.
 */
export function extractSymbolsIn(ctx: AdapterContext, exts: RegExp): Finding<DetectedSymbol>[] {
  const out: Finding<DetectedSymbol>[] = [];
  // name in group depending on the construct; `exported` from a leading `export`.
  const patterns: { re: RegExp; kind: DetectedSymbol["kind"]; nameIdx: number }[] = [
    { re: /^(\s*export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/, kind: "function", nameIdx: 2 },
    { re: /^(\s*export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, kind: "class", nameIdx: 2 },
    { re: /^(\s*export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/, kind: "function", nameIdx: 2 },
    { re: /^(\s*export\s+)?(?:const)\s+([A-Z][A-Z0-9_]*)\s*=/, kind: "const", nameIdx: 2 }, // SCREAMING_CASE consts
    { re: /^(\s*)def\s+([A-Za-z_][\w]*)/, kind: "function", nameIdx: 2 }, // python def
    { re: /^(\s*)class\s+([A-Za-z_][\w]*)/, kind: "class", nameIdx: 2 }, // python class
  ];
  const candidates = ctx.files.filter((f) => exts.test(f) && !f.includes("node_modules"));
  const seen = new Set<string>();
  for (const rel of candidates) {
    const content = ctx.read(rel);
    if (content == null || content.length > 600_000) continue;
    const hash = ctx.fileSource(rel).hash;
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      for (const { re, kind, nameIdx } of patterns) {
        const m = re.exec(line);
        if (!m) continue;
        const name = m[nameIdx];
        if (!name) continue;
        const locator = `${rel}:${i + 1}`;
        if (seen.has(locator)) continue;
        seen.add(locator);
        // python: a def/class indented under another is a method/nested; mark exported
        // = top-level (no indent) for py, or has `export` for ts/js.
        const indented = /^\s+/.test(line);
        const exported = /\bexport\b/.test(m[1] ?? "") || (rel.endsWith(".py") && !indented);
        const symKind: DetectedSymbol["kind"] = rel.endsWith(".py") && indented && kind === "function" ? "method" : kind;
        out.push({
          value: { name, kind: symKind, locator, file: rel, exported, signature: line.trim().slice(0, 160) },
          grounding: ctx.ground([{ kind: "file", ref: rel, locator, hash }], "parsed"),
        });
        break; // one symbol per line
      }
    }
  }
  return out;
}

/** Shared script categorizer (command-book categories, 07-...md §0). */
export function categorizeScript(name: string, command: string): DetectedScript["category"] {
  const hay = `${name} ${command}`.toLowerCase();
  if (/\b(install|ci|bootstrap)\b/.test(hay) || /\b(npm|pnpm|yarn) (ci|install)\b/.test(hay) || /\b(uv sync|pip install|poetry install)\b/.test(hay)) return "install";
  if (/\b(test|pytest|vitest|jest|go test|cargo test)\b/.test(hay)) return "test";
  if (/\b(lint|eslint|ruff|flake8|prettier|clippy|gofmt)\b/.test(hay)) return "lint";
  if (/\b(build|tsc|compile|bundle|cargo build|go build)\b/.test(hay)) return "build";
  if (/\b(dev|serve|start|run|runserver|uvicorn|gunicorn)\b/.test(hay)) return "dev-server";
  if (/\b(deploy|publish|release)\b/.test(hay)) return "deploy";
  if (/\bdocker\b/.test(hay)) return "docker";
  if (/\b(migrate|migration|seed|db)\b/.test(hay)) return "database";
  if (/\b(setup|init|prepare)\b/.test(hay)) return "setup";
  // read-only / inspection commands (status/list/show/version/ps/logs/--help)
  if (/\b(status|list|ls|show|info|inspect|ps|logs|version|--version|--help|-h|check|diff|describe)\b/.test(hay)) return "inspect";
  return "other";
}

/**
 * Shared heuristic route detection over a set of source files. Used by the Node
 * and Python adapters. Honest: matches obvious framework patterns only, requires
 * a leading "/" in the path, dedupes, and is tagged "heuristic" (capped at medium
 * confidence). It does NOT build a call graph.
 */
export function detectRoutesIn(ctx: AdapterContext, exts: RegExp): Finding<DetectedRoute>[] {
  const out: Finding<DetectedRoute>[] = [];
  const patterns: { re: RegExp; method: (m: RegExpMatchArray) => string }[] = [
    // FastAPI/Flask/Starlette decorators: @app.get("/x"), @router.websocket("/y"), @app.route("/z")
    { re: /@\w+\.(get|post|put|delete|patch|websocket|route)\(\s*["'`](\/[^"'`]*)["'`]/g, method: (m) => (m[1] === "route" ? "ANY" : m[1].toUpperCase()) },
    // Express/relay-ish: app.get("/x"  / router.post('/y'
    { re: /\b(?:app|router|server|api)\.(get|post|put|delete|patch|ws|use)\(\s*["'`](\/[^"'`]*)["'`]/g, method: (m) => m[1].toUpperCase() },
  ];
  const candidates = ctx.files.filter((f) => exts.test(f) && !f.includes("__tests__") && !f.includes("/tests/"));
  const seen = new Set<string>();
  for (const rel of candidates) {
    const content = ctx.read(rel);
    if (content == null || content.length > 400_000) continue;
    // Carry the file's content hash so freshness/staleness can track route files
    // (buildGrounding records fileHashes only for sources that have a `hash`).
    const hash = ctx.fileSource(rel).hash;
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
            grounding: ctx.ground([{ kind: "file", ref: rel, locator: `${rel}:${i + 1}`, hash }], "heuristic"),
          });
        }
      }
    }
  }
  return out;
}
