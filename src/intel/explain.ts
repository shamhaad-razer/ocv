// Highlight-to-Explain backend (milestone, 06-highlight-to-explain.md).
//
// Given a highlighted {repo, path, lineRange}, return a SOURCE-GROUNDED explanation
// package a future UI can render. Runs in `ocv` because resolution needs the local
// working tree + the local index, and code must never leave the machine (06-...md
// §3/§5, S1/N1). `service-openclaw` is only a transparent pipe for the eventual
// chat-transport hop — it gets NO new logic here.
//
// HONESTY FIRST (06-...md §5/§8, 13-...md §11): there is NO real call graph yet
// (shallow-graph known-unknown). So callers/callees come from lightweight static
// text search and are explicitly capped at medium confidence; symbol detection is
// regex-heuristic; everything cites its source; and if the index is stale vs the
// working tree, we say so.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { buildGrounding, hashFile } from "./grounding.js";
import type {
  Confidence,
  ExplainPackage,
  ExplainRequest,
  Grounding,
  KnownUnknown,
  RefHit,
  RelatedIntel,
  RepoIntel,
  SourceRef,
  SymbolHit,
  WorkspaceIntel,
} from "./types.js";

const MAX_SELECTED_LINES = 120;
const MAX_REFS = 12;
const MAX_SCAN_FILES = 4000;

const IGNORE_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".next", ".venv", "venv",
  "__pycache__", ".turbo", "coverage", ".pytest_cache", "dist-scan",
]);

/** Bounded list of repo-relative source files, for caller search. Cheap re-walk. */
export function listRepoFiles(root: string, max = MAX_SCAN_FILES): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length && out.length < max) {
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
      if (isDir) {
        if (!IGNORE_DIRS.has(name)) stack.push(abs);
      } else if (/\.(ts|tsx|js|mjs|py)$/.test(name)) {
        out.push(relative(root, abs));
      }
    }
  }
  return out;
}

/** Regex for declared symbols across the languages we scan (TS/JS/Python). Heuristic. */
const SYMBOL_RE =
  /(?:export\s+)?(?:async\s+)?(?:function|class)\s+([A-Za-z_$][\w$]*)|(?:def|class)\s+([A-Za-z_][\w]*)|(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)\s*=>|function)/;

function symbolKindFor(line: string): SymbolHit["kind"] {
  if (/\b(class)\b/.test(line)) return "class";
  if (/\b(def|function)\b/.test(line)) return "function";
  if (/\b(const|let|var)\b/.test(line)) return "const";
  return "unknown";
}

function detectSymbolOnLine(line: string): string | null {
  const m = SYMBOL_RE.exec(line);
  if (!m) return null;
  return m[1] ?? m[2] ?? m[3] ?? null;
}

/** Read the file; return its lines, or null if unreadable. */
function readLines(abs: string): string[] | null {
  try {
    return readFileSync(abs, "utf-8").split(/\r?\n/);
  } catch {
    return null;
  }
}

/**
 * Find the symbol that ENCLOSES the selection by scanning upward from startLine
 * for the nearest declaration. Heuristic (no brace/indent analysis).
 */
function findEnclosingSymbol(lines: string[], startLine: number, path: string): SymbolHit | null {
  for (let i = Math.min(startLine - 1, lines.length - 1); i >= 0; i--) {
    const name = detectSymbolOnLine(lines[i]);
    if (name) {
      return {
        name,
        kind: symbolKindFor(lines[i]),
        locator: `${path}:${i + 1}`,
        signature: lines[i].trim().slice(0, 200),
      };
    }
  }
  return null;
}

/** Symbols declared *inside* the selected range. */
function findNearbySymbols(lines: string[], start: number, end: number, path: string): SymbolHit[] {
  const out: SymbolHit[] = [];
  for (let i = start - 1; i < Math.min(end, lines.length); i++) {
    if (i < 0) continue;
    const name = detectSymbolOnLine(lines[i]);
    if (name) out.push({ name, kind: symbolKindFor(lines[i]), locator: `${path}:${i + 1}`, signature: lines[i].trim().slice(0, 200) });
  }
  return out;
}

/** Callees: bare `name(` calls referenced inside the selection (excluding the symbol itself). */
function findCallees(selected: string[], path: string, start: number, excludeName: string | null): RefHit[] {
  const seen = new Map<string, RefHit>();
  const callRe = /\b([A-Za-z_$][\w$]*)\s*\(/g;
  const KEYWORDS = new Set(["if", "for", "while", "switch", "catch", "return", "function", "await", "typeof", "super", "constructor"]);
  selected.forEach((line, idx) => {
    let m: RegExpExecArray | null;
    callRe.lastIndex = 0;
    while ((m = callRe.exec(line)) !== null) {
      const name = m[1];
      if (KEYWORDS.has(name) || name === excludeName) continue;
      if (!seen.has(name)) seen.set(name, { name, locator: `${path}:${start + idx}`, snippet: line.trim().slice(0, 160) });
    }
  });
  return [...seen.values()].slice(0, MAX_REFS);
}

/**
 * Likely callers: static text search across the repo for `enclosingName(`.
 * Heuristic (a string match isn't a call); bounded by file count. Capped confidence.
 */
function findCallers(repoRoot: string, repoFiles: string[], name: string): RefHit[] {
  const out: RefHit[] = [];
  const re = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\(`);
  let scanned = 0;
  for (const rel of repoFiles) {
    if (scanned >= MAX_SCAN_FILES) break;
    if (!/\.(ts|tsx|js|mjs|py)$/.test(rel)) continue;
    scanned++;
    const lines = readLines(join(repoRoot, rel));
    if (!lines) continue;
    for (let i = 0; i < lines.length; i++) {
      // Keep same-file references (recursion/internal use); skip the declaration line itself.
      if (re.test(lines[i]) && !/\b(function|def|class)\s/.test(lines[i])) {
        out.push({ name, locator: `${rel}:${i + 1}`, snippet: lines[i].trim().slice(0, 160) });
        if (out.length >= MAX_REFS) return out;
      }
    }
  }
  return out;
}

/** Find the most recent recorded content hash for a file across all index findings. */
function findRecordedHash(repo: RepoIntel, path: string): string | undefined {
  const groundings: Grounding[] = [
    repo.grounding,
    ...repo.packageFiles.map((f) => f.grounding),
    ...repo.docFiles.map((f) => f.grounding),
    ...repo.routes.map((f) => f.grounding),
    ...repo.envFiles.map((f) => f.grounding),
    ...repo.deployFiles.map((f) => f.grounding),
  ];
  for (const g of groundings) {
    const hit = g.fileHashes.find((h) => h.ref === path);
    if (hit) return hit.hash;
  }
  return undefined;
}

/** Pull index entities that reference this file (routes/scripts/env/services). */
function relatedFromIndex(repo: RepoIntel, path: string): RelatedIntel {
  const inFile = (locator?: string) => !!locator && locator.startsWith(path);
  return {
    routes: repo.routes
      .filter((r) => inFile(r.value.locator))
      .map((r) => ({ method: r.value.method, pathPattern: r.value.pathPattern, locator: r.value.locator })),
    scripts: repo.scripts.map((s) => ({ name: s.value.name, command: s.value.command })).slice(0, 10),
    envVars: repo.envVars.map((e) => e.value.name).slice(0, 30),
    services: repo.services.filter((s) => s.value.evidence === path).map((s) => s.value.name),
  };
}

export interface ExplainOptions {
  generatedAt: number;
  /** The list of repo-relative files (from the index/scan) for caller search. */
  repoFiles?: string[];
}

/**
 * Resolve a highlighted selection into a grounded explanation package.
 * `ws` is the loaded project intelligence index; `repoFiles` (optional) lets the
 * caller pass the file list for caller search without re-walking.
 */
export function explainSelection(req: ExplainRequest, ws: WorkspaceIntel, opts: ExplainOptions): ExplainPackage {
  const now = opts.generatedAt;
  const repo = ws.repos.find((r) => r.name === req.repo);
  const knownUnknowns: KnownUnknown[] = [];
  const followups: string[] = [];
  const sources: SourceRef[] = [];

  // --- guard: repo not in index ---
  if (!repo) {
    return emptyPackage(req, now, ws, `repo \`${req.repo}\` is not in the project intelligence index`, [
      mkUnknown("other", "repo not indexed", `\`${req.repo}\` was not found in the last scan; run \`npm run scan\` first.`, "high"),
    ]);
  }

  const abs = join(repo.rootPath, req.path);
  const lines = readLines(abs);
  if (!lines) {
    return emptyPackage(req, now, ws, `file \`${req.path}\` could not be read in \`${req.repo}\``, [
      mkUnknown("other", "file unreadable", `\`${req.path}\` was not readable at ${abs}.`, "high"),
    ]);
  }

  // --- freshness: is the index stale vs the working tree for this file? ---
  // Look for a recorded hash of THIS file anywhere in the index (repo-level
  // grounding only covers manifests; route/symbol findings carry per-file hashes).
  const fileHash = hashFile(abs);
  let staleWarning: string | undefined;
  let freshness = repo.grounding.status;
  const recordedHash = findRecordedHash(repo, req.path);
  if (recordedHash && fileHash && recordedHash !== fileHash) {
    staleWarning = `\`${req.path}\` has changed since the last scan (index commit \`${repo.gitCommit ?? "?"}\`). Explanation reflects the CURRENT file, but related index data may be stale — re-run \`npm run scan\`.`;
    freshness = "potentially-stale";
  }

  // --- clamp the range to the file ---
  const start = Math.max(1, Math.min(req.startLine, lines.length));
  const end = Math.max(start, Math.min(req.endLine, lines.length));
  const selected = lines.slice(start - 1, end);
  const selectedCode = selected.slice(0, MAX_SELECTED_LINES).join("\n");
  sources.push({ kind: "file", ref: req.path, locator: `${req.path}:${start}-${end}`, hash: fileHash ?? undefined });

  // --- symbols ---
  const enclosing = findEnclosingSymbol(lines, start, req.path);
  const nearby = findNearbySymbols(lines, start, end, req.path);
  if (enclosing) sources.push({ kind: "file", ref: req.path, locator: enclosing.locator });

  // --- callees (inside selection) + callers (static search) ---
  const callees = findCallees(selected, req.path, start, enclosing?.name ?? null);
  const repoFiles = opts.repoFiles ?? [];
  let callers: RefHit[] = [];
  if (enclosing && repoFiles.length) {
    callers = findCallers(repo.rootPath, repoFiles, enclosing.name);
  }

  // --- related index entities ---
  const related = relatedFromIndex(repo, req.path);

  // --- honesty: no real call graph; callers/callees are heuristic ---
  knownUnknowns.push(
    mkUnknown(
      "shallow-graph",
      "no call graph — callers/callees are heuristic",
      "Callers/callees come from static text search (a name match is not proven a call). No real call graph exists yet (milestone 4).",
      "medium",
    ),
  );
  if (enclosing && repoFiles.length === 0) {
    knownUnknowns.push(
      mkUnknown("route-without-caller", "caller search skipped", "No file list was provided, so caller search did not run.", "medium"),
    );
  }
  if (!enclosing) {
    knownUnknowns.push(
      mkUnknown("other", "no enclosing symbol detected", "The selection isn't inside a detectable function/class (or the language isn't parsed). Explanation is line-level only.", "medium"),
    );
  }

  // --- confidence: the analysis is heuristic (capped at medium); a stale file
  // drops it to low. We take the WORSE of the calculus result and this cap so the
  // package never over-claims (06-...md §5/§8, 13-...md §11). ---
  const heuristicCap: Confidence = staleWarning ? "low" : "medium";

  // --- follow-ups that would raise confidence (13-...md §7) ---
  if (staleWarning) followups.push("Re-run `npm run scan` to refresh the index for this file.");
  if (enclosing) {
    followups.push(`Confirm callers by searching the workspace for \`${enclosing.name}(\` (current results are heuristic).`);
    followups.push(`Open the related route/script entities to verify how \`${enclosing.name}\` is reached at runtime.`);
  }
  followups.push("Run the repo's tests to confirm the selected code's behavior (no runtime verification yet).");

  const grounding: Grounding = buildGrounding({
    generatedAt: now,
    baseCommit: repo.gitCommit,
    sources,
    analysisQuality: "heuristic",
    status: freshness,
    basisOverrides: staleWarning ? { freshness: "potentially-stale" } : undefined,
    knownUnknownIds: knownUnknowns.map((u) => u.id),
  });

  const explanation = buildExplanation(req, enclosing, callees, callers, related, selected.length);

  return {
    request: req,
    explanation,
    enclosingSymbol: enclosing,
    nearbySymbols: nearby,
    likelyCallers: callers,
    likelyCallees: callees,
    related,
    selectedCode,
    evidence: {
      sources,
      scanGeneratedAt: ws.generatedAt,
      scanVersion: ws.scanVersion,
      baseCommit: repo.gitCommit,
    },
    confidence: worseConfidence(grounding.confidence, heuristicCap),
    freshness,
    staleWarning,
    knownUnknowns,
    suggestedFollowups: followups,
    grounding,
  };
}

/** Junior-friendly prose. Concrete, hedged, no fabrication beyond what was found. */
function buildExplanation(
  req: ExplainRequest,
  enclosing: SymbolHit | null,
  callees: RefHit[],
  callers: RefHit[],
  related: RelatedIntel,
  lineCount: number,
): string {
  const parts: string[] = [];
  const where = enclosing
    ? `This selection is inside \`${enclosing.name}\` (a ${enclosing.kind}) in \`${req.path}\`.`
    : `This is a ${lineCount}-line selection in \`${req.path}\` that isn't inside a detected function/class.`;
  parts.push(where);

  if (enclosing?.signature) parts.push(`It's declared as: \`${enclosing.signature}\`.`);

  if (callees.length) {
    parts.push(`Inside the selection it calls: ${callees.slice(0, 6).map((c) => `\`${c.name}()\``).join(", ")}${callees.length > 6 ? `, +${callees.length - 6} more` : ""}. (These are name matches, so treat them as *likely* calls.)`);
  } else {
    parts.push("No obvious function calls were detected inside the selection.");
  }

  if (callers.length) {
    parts.push(`It looks like it's referenced from ${callers.length} place(s) — e.g. \`${callers[0].locator}\`. (Found by text search, not a verified call graph.)`);
  } else if (enclosing) {
    parts.push("No callers were found by static search — it may be unused, called dynamically, or called from a repo that wasn't searched.");
  }

  if (related.routes.length) {
    parts.push(`This file declares route(s): ${related.routes.slice(0, 4).map((r) => `\`${r.method} ${r.pathPattern}\``).join(", ")} — so this code likely runs when those endpoints are hit.`);
  }

  const lens = req.experienceLevel ?? "junior";
  if (lens === "junior" || lens === "new-to-repo") {
    parts.push("Heads-up: this explanation is built from a quick static scan, not from running the code — verify the callers and run the tests before relying on it.");
  }
  return parts.join(" ");
}

/** Return the more conservative (lower) of two confidence levels. */
function worseConfidence(a: Confidence, b: Confidence): Confidence {
  const rank: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };
  return rank[a] <= rank[b] ? a : b;
}

function mkUnknown(kind: KnownUnknown["kind"], title: string, detail: string, impact: Confidence): KnownUnknown {
  return { id: `explain:${kind}:${title.replace(/\s+/g, "-")}`, kind, title, detail, evidence: [], status: "open", confidenceImpact: impact };
}

function emptyPackage(
  req: ExplainRequest,
  now: number,
  ws: WorkspaceIntel,
  explanation: string,
  unknowns: KnownUnknown[],
): ExplainPackage {
  const grounding = buildGrounding({
    generatedAt: now,
    baseCommit: null,
    sources: [],
    analysisQuality: "inferred",
    knownUnknownIds: unknowns.map((u) => u.id),
  });
  return {
    request: req,
    explanation,
    enclosingSymbol: null,
    nearbySymbols: [],
    likelyCallers: [],
    likelyCallees: [],
    related: { routes: [], scripts: [], envVars: [], services: [] },
    selectedCode: "",
    evidence: { sources: [], scanGeneratedAt: ws.generatedAt, scanVersion: ws.scanVersion, baseCommit: null },
    confidence: "low",
    freshness: "unverified",
    knownUnknowns: unknowns,
    suggestedFollowups: ["Run `npm run scan` to (re)build the index, then retry."],
    grounding,
  };
}
