import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const distDir = join(root, "dist");

mkdirSync(distDir, { recursive: true });

try {
  const { build } = await import("esbuild");
  await build({
    entryPoints: [join(root, "src/index.ts")],
    bundle: true,
    format: "esm",
    platform: "node",
    outfile: join(distDir, "index.mjs"),
    external: ["openclaw"],
  });
} catch (err) {
  if (err.code === "ERR_MODULE_NOT_FOUND" || err.code === "MODULE_NOT_FOUND") {
    console.warn("[cloud-relay] esbuild not available, skipping build (using pre-built dist)");
  } else {
    throw err;
  }
}
