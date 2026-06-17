// Make / Just adapter (cross-language): treats Makefile/Justfile targets as
// runnable commands. Applies alongside language adapters (a repo can have both).

import type { DetectedScript, Finding } from "../types.js";
import { type Adapter, type AdapterContext, type AdapterResult, categorizeScript, emptyResult } from "./types.js";

function parseTargets(ctx: AdapterContext, file: string, runner: string): Finding<DetectedScript>[] {
  const out: Finding<DetectedScript>[] = [];
  const content = ctx.read(file);
  if (content == null) return out;
  const hash = ctx.fileSource(file).hash;
  content.split(/\r?\n/).forEach((line, i) => {
    const m = /^([a-zA-Z0-9_.-]+):(?!=)/.exec(line);
    if (m && !line.startsWith("\t")) {
      const name = m[1];
      out.push({
        value: { name, command: `${runner} ${name}`, source: file, category: categorizeScript(name, name) },
        grounding: ctx.ground([{ kind: "file", ref: file, locator: `${file}:${i + 1}`, hash }], "declared"),
      });
    }
  });
  return out;
}

export const makeAdapter: Adapter = {
  id: "make",
  description: "Make / Just (Makefile/Justfile targets as commands)",
  appliesTo: (ctx) => ctx.has("Makefile") || ctx.has("Justfile"),
  detect: (ctx): AdapterResult => {
    const res = emptyResult("make", "declared", true); // `make`/`just` are real runners
    if (ctx.has("Makefile")) res.scripts.push(...parseTargets(ctx, "Makefile", "make"));
    if (ctx.has("Justfile")) res.scripts.push(...parseTargets(ctx, "Justfile", "just"));
    res.evidence = ["Makefile", "Justfile"].filter((f) => ctx.has(f)).map((f) => ctx.fileSource(f));
    return res;
  },
};
