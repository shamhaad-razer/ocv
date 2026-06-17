// Manifest-level adapters for Go and Rust (prompt 30 req #5). These don't parse
// deep structure — they recognize the manifest and synthesize the CANONICAL
// commands for that ecosystem (inferred quality), so a Go/Rust target gets
// useful build/test commands instead of "no commands". Honest: synthesized, not
// declared; flagged as such.

import type { DetectedScript, Finding } from "../types.js";
import { type Adapter, type AdapterContext, type AdapterResult, emptyResult } from "./types.js";

function syntheticScripts(ctx: AdapterContext, manifest: string, cmds: { name: string; command: string; category: DetectedScript["category"] }[]): Finding<DetectedScript>[] {
  const src = ctx.fileSource(manifest);
  return cmds.map((c) => ({
    value: { name: c.name, command: c.command, source: manifest, category: c.category },
    grounding: ctx.ground([{ kind: "file", ref: manifest, locator: c.name, hash: src.hash }], "inferred"),
  }));
}

export const goAdapter: Adapter = {
  id: "go",
  description: "Go (go.mod → canonical go build/test/run commands)",
  appliesTo: (ctx) => ctx.has("go.mod"),
  detect: (ctx): AdapterResult => {
    const res = emptyResult("go", "inferred", true);
    res.scripts = syntheticScripts(ctx, "go.mod", [
      { name: "build", command: "go build ./...", category: "build" },
      { name: "test", command: "go test ./...", category: "test" },
      { name: "run", command: "go run .", category: "dev-server" },
    ]);
    res.evidence = [ctx.fileSource("go.mod")];
    res.knownUnknowns.push({
      id: "go:synthesized-commands",
      kind: "unvalidated-command",
      title: "Go commands are canonical, not declared",
      detail: "go.mod implies the standard go build/test/run; the project may use a Makefile or task runner instead.",
      evidence: [ctx.fileSource("go.mod")],
      status: "open",
      confidenceImpact: "low",
    });
    return res;
  },
};

export const rustAdapter: Adapter = {
  id: "rust",
  description: "Rust (Cargo.toml → canonical cargo build/test/run commands)",
  appliesTo: (ctx) => ctx.has("Cargo.toml"),
  detect: (ctx): AdapterResult => {
    const res = emptyResult("rust", "inferred", true);
    res.scripts = syntheticScripts(ctx, "Cargo.toml", [
      { name: "build", command: "cargo build", category: "build" },
      { name: "test", command: "cargo test", category: "test" },
      { name: "run", command: "cargo run", category: "dev-server" },
    ]);
    res.evidence = [ctx.fileSource("Cargo.toml")];
    res.knownUnknowns.push({
      id: "rust:synthesized-commands",
      kind: "unvalidated-command",
      title: "Rust commands are canonical, not declared",
      detail: "Cargo.toml implies the standard cargo build/test/run; custom xtasks or Makefiles aren't parsed.",
      evidence: [ctx.fileSource("Cargo.toml")],
      status: "open",
      confidenceImpact: "low",
    });
    return res;
  },
};
