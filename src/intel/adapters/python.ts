// Python adapter (prompt 30): the headline breadth improvement. Parses scripts
// from pyproject.toml ([project.scripts], [tool.poetry.scripts]) + tool config,
// recognizes the common runners (uv / pytest / ruff / uvicorn), detects
// FastAPI/Flask routes, and a python service entrypoint. Lightweight TOML
// parsing (no dependency) — honest about what it can't parse.

import type { DetectedScript, DetectedService, Finding } from "../types.js";
import { type Adapter, type AdapterContext, type AdapterResult, categorizeScript, detectRoutesIn, emptyResult, extractSymbolsIn } from "./types.js";

/** Extract `name = "value"` entries under a given TOML [section]. Minimal, no deps. */
function tomlSectionEntries(toml: string, section: string): { name: string; value: string }[] {
  const lines = toml.split(/\r?\n/);
  const out: { name: string; value: string }[] = [];
  let inSection = false;
  for (const line of lines) {
    const header = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (header) {
      inSection = header[1].trim() === section;
      continue;
    }
    if (!inSection) continue;
    const m = /^\s*([A-Za-z0-9_.\-]+)\s*=\s*"([^"]*)"/.exec(line);
    if (m) out.push({ name: m[1], value: m[2] });
  }
  return out;
}

/** Does pyproject declare a dependency/tool implying a runner? (for synthesizing common commands) */
function pyprojectMentions(toml: string, needle: RegExp): boolean {
  return needle.test(toml);
}

function detectPythonScripts(ctx: AdapterContext): { scripts: Finding<DetectedScript>[]; verifiable: boolean } {
  const out: Finding<DetectedScript>[] = [];
  let verifiable = false;
  const pyproject = ctx.read("pyproject.toml");

  if (pyproject != null) {
    const src = ctx.fileSource("pyproject.toml");
    // Declared console entry points: [project.scripts] and [tool.poetry.scripts]
    for (const section of ["project.scripts", "tool.poetry.scripts"]) {
      for (const { name, value } of tomlSectionEntries(pyproject, section)) {
        out.push({
          value: { name, command: name, source: "pyproject.toml", category: categorizeScript(name, value) },
          grounding: ctx.ground([{ kind: "file", ref: "pyproject.toml", locator: `[${section}] ${name}`, hash: src.hash }], "declared"),
        });
      }
    }
    // Common runners implied by declared tooling — synthesized (not declared scripts),
    // so they're "inferred" quality and clearly the standard invocation.
    const uv = ctx.has("uv.lock") || pyprojectMentions(pyproject, /\[tool\.uv\]/);
    const runner = uv ? "uv run" : "python -m";
    if (uv) verifiable = true;
    if (pyprojectMentions(pyproject, /pytest/)) {
      out.push({
        value: { name: "test", command: uv ? "uv run pytest" : "python -m pytest", source: "pyproject.toml", category: "test" },
        grounding: ctx.ground([{ kind: "file", ref: "pyproject.toml", locator: "pytest", hash: src.hash }], "inferred"),
      });
    }
    if (pyprojectMentions(pyproject, /ruff/)) {
      out.push({
        value: { name: "lint", command: `${runner} ruff check .`, source: "pyproject.toml", category: "lint" },
        grounding: ctx.ground([{ kind: "file", ref: "pyproject.toml", locator: "ruff", hash: src.hash }], "inferred"),
      });
    }
  }

  // requirements.txt implies pip install (the canonical setup step).
  if (ctx.has("requirements.txt")) {
    out.push({
      value: { name: "install", command: "pip install -r requirements.txt", source: "requirements.txt", category: "install" },
      grounding: ctx.ground([ctx.fileSource("requirements.txt")], "inferred"),
    });
  } else if (ctx.has("uv.lock")) {
    out.push({
      value: { name: "install", command: "uv sync", source: "uv.lock", category: "install" },
      grounding: ctx.ground([ctx.fileSource("uv.lock")], "inferred"),
    });
    verifiable = true;
  }

  return { scripts: out, verifiable };
}

function detectPythonServices(ctx: AdapterContext): Finding<DetectedService>[] {
  const out: Finding<DetectedService>[] = [];
  const pyEntry = ctx.files.find((f) => /(^|\/)(bot|main|app|server|wsgi|asgi|manage)\.py$/.test(f));
  if (pyEntry) {
    out.push({
      value: { name: pyEntry.replace(/\//g, ":"), kind: "http", evidence: pyEntry },
      grounding: ctx.ground([ctx.fileSource(pyEntry)], "heuristic"),
    });
  }
  return out;
}

export const pythonAdapter: Adapter = {
  id: "python",
  description: "Python (pyproject.toml [project.scripts]/[tool.poetry.scripts], requirements.txt, uv/pytest/ruff, FastAPI/Flask routes)",
  appliesTo: (ctx) =>
    ctx.has("pyproject.toml") || ctx.has("requirements.txt") || ctx.has("setup.py") || ctx.has("setup.cfg") || ctx.files.some((f) => f.endsWith(".py")),
  detect: (ctx): AdapterResult => {
    const res = emptyResult("python", "declared", false);
    const { scripts, verifiable } = detectPythonScripts(ctx);
    res.scripts = scripts;
    res.routes = detectRoutesIn(ctx, /\.py$/);
    res.symbols = extractSymbolsIn(ctx, /\.py$/);
    res.services = detectPythonServices(ctx);
    res.runtimeVerifiable = verifiable;
    res.evidence = ["pyproject.toml", "requirements.txt", "uv.lock"].filter((f) => ctx.has(f)).map((f) => ctx.fileSource(f));

    const hasManifest = ctx.has("pyproject.toml") || ctx.has("requirements.txt") || ctx.has("setup.py");
    if (!hasManifest) {
      // .py files but no manifest → we can detect routes but not commands.
      res.quality = "heuristic";
      res.knownUnknowns.push({
        id: "python:no-manifest",
        kind: "unvalidated-command",
        title: "Python sources but no manifest",
        detail: "Found .py files but no pyproject.toml/requirements.txt/setup.py; install/run/test commands can't be derived.",
        evidence: [],
        status: "open",
        confidenceImpact: "medium",
      });
    } else if (scripts.length === 0) {
      res.knownUnknowns.push({
        id: "python:no-scripts",
        kind: "unvalidated-command",
        title: "no Python commands derived",
        detail: "A Python manifest exists but no console scripts or known runners (pytest/ruff/uv) were found in it.",
        evidence: res.evidence,
        status: "open",
        confidenceImpact: "medium",
      });
    }
    return res;
  },
};
