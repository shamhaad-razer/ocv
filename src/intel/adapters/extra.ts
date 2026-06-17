// Cross-language command sources (prompt 31): shell scripts, README fenced
// commands, and docker-compose services. These broaden the command book for
// external projects whose run knowledge lives outside a manifest. All grounded,
// all honest about confidence (README/compose are lower-confidence than a
// declared manifest script).

import type { DetectedScript, Finding } from "../types.js";
import { type Adapter, type AdapterContext, type AdapterResult, categorizeScript, emptyResult } from "./types.js";

/** Top-level executable-ish shell scripts + anything under a scripts/ dir. */
function detectShellScripts(ctx: AdapterContext): Finding<DetectedScript>[] {
  const out: Finding<DetectedScript>[] = [];
  const candidates = ctx.files.filter(
    (f) => f.endsWith(".sh") || /(^|\/)scripts\/[^/]+$/.test(f),
  );
  for (const rel of candidates) {
    // skip obvious non-runnables in scripts/ (e.g. .md, .json fixtures)
    if (/\.(md|json|ya?ml|txt|lock)$/.test(rel)) continue;
    const base = rel.split("/").pop() ?? rel;
    const name = base.replace(/\.sh$/, "");
    out.push({
      value: { name, command: `./${rel}`, source: rel, category: categorizeScript(name, rel) },
      grounding: ctx.ground([ctx.fileSource(rel)], "heuristic"),
    });
  }
  return out;
}

/** Commands found in README fenced ```bash/```sh blocks. Lower confidence (prose). */
function detectReadmeCommands(ctx: AdapterContext): { scripts: Finding<DetectedScript>[]; readmeFound: boolean } {
  const out: Finding<DetectedScript>[] = [];
  const readme = ctx.files.find((f) => /(^|\/)readme(\.md|\.txt|\.rst)?$/i.test(f));
  if (!readme) return { scripts: out, readmeFound: false };
  const content = ctx.read(readme);
  if (content == null) return { scripts: out, readmeFound: true };

  const lines = content.split(/\r?\n/);
  const hash = ctx.fileSource(readme).hash;
  const seen = new Set<string>();
  // A fenced code block toggles on/off at each ``` line; inside a block, lines
  // starting with a known runner are treated as commands. Recognize a real runner
  // up front so prose/output isn't mis-detected as a command.
  const RUNNER = /^(npm|pnpm|yarn|npx|node|python3?|pip|uv|poetry|pytest|ruff|go|cargo|make|just|docker|docker-compose|bash|sh|\.\/)\b/;
  let inBlock = false;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t.startsWith("```")) {
      inBlock = !inBlock;
      continue;
    }
    if (!inBlock) continue;
    const cmd = t.replace(/^\$\s+/, "").trim().slice(0, 200); // strip a leading "$ "
    if (!cmd || cmd.startsWith("#") || !RUNNER.test(cmd)) continue;
    if (seen.has(cmd)) continue;
    seen.add(cmd);
    out.push({
      value: { name: `readme:${seen.size}`, command: cmd, source: readme, category: categorizeScript("", cmd) },
      grounding: ctx.ground([{ kind: "file", ref: readme, locator: `${readme}:${i + 1}`, hash }], "heuristic"),
    });
  }
  return { scripts: out.slice(0, 25), readmeFound: true };
}

/** docker-compose services → a `docker compose up <svc>` command (confirm-gated later). */
function detectComposeServices(ctx: AdapterContext): Finding<DetectedScript>[] {
  const out: Finding<DetectedScript>[] = [];
  const compose = ctx.files.find((f) => /(^|\/)docker-compose(\.[\w-]+)?\.ya?ml$/.test(f));
  if (!compose) return out;
  const content = ctx.read(compose);
  if (content == null) return out;
  const hash = ctx.fileSource(compose).hash;
  const lines = content.split(/\r?\n/);
  // Find the `services:` block and its top-level keys (2-space indented).
  let inServices = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^services:\s*$/.test(line)) { inServices = true; continue; }
    if (inServices && /^\S/.test(line)) inServices = false; // dedented out
    if (!inServices) continue;
    const m = /^  ([A-Za-z0-9_.-]+):\s*$/.exec(line);
    if (m) {
      const svc = m[1];
      out.push({
        value: { name: `compose:${svc}`, command: `docker compose up ${svc}`, source: compose, category: "docker" },
        grounding: ctx.ground([{ kind: "file", ref: compose, locator: `${compose}:${i + 1}`, hash }], "heuristic"),
      });
    }
  }
  return out;
}

export const extraCommandsAdapter: Adapter = {
  id: "extra-commands",
  description: "Cross-language command sources (shell scripts, README commands, docker-compose services)",
  appliesTo: (ctx) =>
    ctx.files.some((f) => f.endsWith(".sh") || /(^|\/)scripts\//.test(f)) ||
    ctx.files.some((f) => /(^|\/)readme(\.md|\.txt|\.rst)?$/i.test(f)) ||
    ctx.files.some((f) => /(^|\/)docker-compose(\.[\w-]+)?\.ya?ml$/.test(f)),
  detect: (ctx): AdapterResult => {
    const res = emptyResult("extra-commands", "heuristic", false);
    res.scripts.push(...detectShellScripts(ctx));
    const { scripts: readmeCmds } = detectReadmeCommands(ctx);
    res.scripts.push(...readmeCmds);
    res.scripts.push(...detectComposeServices(ctx));
    res.evidence = res.scripts.slice(0, 5).map((s) => ctx.fileSource(s.value.source));
    return res;
  },
};
