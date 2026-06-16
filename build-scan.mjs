// Bundle the project-intelligence scanner CLI into dist-scan/cli.mjs.
// Mirrors build.mjs (the plugin bundle); kept separate so the scanner can be
// built/run without touching the plugin entry point.

import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const distDir = join(root, "dist-scan");

mkdirSync(distDir, { recursive: true });

try {
  const { build } = await import("esbuild");
  await build({
    entryPoints: [join(root, "src/intel/cli.ts")],
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node20",
    outfile: join(distDir, "cli.mjs"),
    // Node builtins only; nothing external to mark.
  });
  console.log("[scan] built dist-scan/cli.mjs");
} catch (err) {
  if (err.code === "ERR_MODULE_NOT_FOUND" || err.code === "MODULE_NOT_FOUND") {
    console.warn("[scan] esbuild not available, skipping build");
  } else {
    throw err;
  }
}
