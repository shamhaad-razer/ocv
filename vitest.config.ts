import { defineConfig } from "vitest/config";
import path from "node:path";

// The plugin imports one host-provided module, `openclaw/plugin-sdk/session-store-runtime`,
// which esbuild marks `external` for the real bundle. Under Vitest there's no
// host runtime, so alias that specifier to a local test stub. Nothing else in
// src/ depends on the host at import time.
export default defineConfig({
  resolve: {
    alias: {
      "openclaw/plugin-sdk/session-store-runtime": path.resolve(
        __dirname,
        "src/__tests__/_stubs/session-store-runtime.ts",
      ),
    },
  },
  test: {
    // _stubs holds helpers, not test files.
    exclude: ["**/node_modules/**", "**/dist/**", "**/_stubs/**"],
  },
});
