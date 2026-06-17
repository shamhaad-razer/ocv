// Symbol reference search (prompt 33). Pure + host-only: given a symbol name,
// find textual references across the target and classify each by how strongly it
// implies usage. READ-ONLY — only reads files under the target root.
//
// PRINCIPLE (prompt 33): never assert a caller relationship as fact. A textual
// match is evidence, not proof:
//   definition → high   (it IS the symbol's declaration)
//   call `name(` → medium (very likely a call, but could be a different symbol)
//   import line  → medium (the symbol is imported here → used somewhere in file)
//   bare mention → low    (could be a comment, string, or unrelated identifier)

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ReferenceResult, SymbolReference } from "./types.js";

const MAX_FILES = 4000;
const MAX_REFS = 50;

/** Escape a name for safe use in a RegExp. */
function esc(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Search the target for references to `symbol`. `files` are repo-relative source
 * paths (from the index/scan); `defLocator` (optional "file:line") marks the known
 * definition so it's classified "definition/high" rather than a generic mention.
 */
export function findReferences(
  repoRoot: string,
  files: string[],
  symbol: string,
  defLocator?: string,
): ReferenceResult {
  const refs: SymbolReference[] = [];
  const word = new RegExp(`\\b${esc(symbol)}\\b`);
  const call = new RegExp(`\\b${esc(symbol)}\\s*\\(`);
  const importLine = /\b(import|from|require)\b/;
  const defLine = /\b(function|class|def|const|let|var)\b/;

  const candidates = files.filter((f) => /\.(ts|tsx|js|mjs|py|go|rs)$/.test(f) && !f.includes("node_modules"));
  let searched = 0;
  let truncated = false;

  for (const rel of candidates) {
    if (searched >= MAX_FILES) { truncated = true; break; }
    searched++;
    let content: string;
    try {
      content = readFileSync(join(repoRoot, rel), "utf-8");
    } catch {
      continue;
    }
    if (content.length > 600_000) continue;
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!word.test(line)) continue;
      const locator = `${rel}:${i + 1}`;
      let kind: SymbolReference["kind"];
      let confidence: SymbolReference["confidence"];
      if (defLocator && locator === defLocator) {
        kind = "definition"; confidence = "high";
      } else if (defLine.test(line) && new RegExp(`\\b(function|class|def|const|let|var)\\s+${esc(symbol)}\\b`).test(line)) {
        kind = "definition"; confidence = "high"; // another declaration of the same name
      } else if (call.test(line)) {
        kind = "call"; confidence = "medium";
      } else if (importLine.test(line)) {
        kind = "import"; confidence = "medium";
      } else {
        kind = "mention"; confidence = "low";
      }
      refs.push({ locator, snippet: line.trim().slice(0, 160), kind, confidence });
      if (refs.length >= MAX_REFS) { truncated = true; break; }
    }
    if (refs.length >= MAX_REFS) break;
  }

  return { symbol, references: refs, filesSearched: searched, truncated };
}

/** Split a reference result into likely callers (call/import) vs. all references. */
export function likelyCallersFrom(result: ReferenceResult, excludeDefFile?: string): SymbolReference[] {
  return result.references.filter(
    (r) => (r.kind === "call" || r.kind === "import") && (!excludeDefFile || !r.locator.startsWith(`${excludeDefFile}:`)),
  );
}
