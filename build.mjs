import { execSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const distDir = join(root, "dist");

mkdirSync(distDir, { recursive: true });

execSync(
  `npx --yes esbuild src/index.ts --bundle --format=esm --platform=node --outfile=dist/index.mjs --external:openclaw`,
  { cwd: root, stdio: "inherit" },
);
