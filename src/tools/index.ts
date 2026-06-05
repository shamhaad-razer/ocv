import { logger } from "../logger.js";
import { locationTool } from "./location.js";
import type { PluginApi } from "../types.js";

/**
 * Register the agent tools whose execution lives in the browser.
 */
export function registerBrowserTools(api: PluginApi): void {
  if (typeof api.registerTool !== "function") {
    logger.warn("[cloud-relay] registerTool unavailable; browser tools not registered");
    return;
  }

  // One line per tool — comment a line out to disable that tool.
  const tools = [
    locationTool(),
  ];
  for (const tool of tools) {
    api.registerTool(tool, { optional: true });
  }

  logger.info(
    `[cloud-relay] registered agent tools: ${tools.map((t) => t.name).join(", ")}`,
  );
}
