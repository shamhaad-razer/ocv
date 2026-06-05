import { logger } from "../logger.js";
import { getRelayState } from "../state.js";
import type { AgentToolResult } from "../types.js";

interface InvokeResponse {
  ok?: boolean;
  text?: string;
  error?: string;
}

/**
 * Invoke a browser-side tool and await its result.
 */
export async function invokeBrowserTool(
  tool: string,
  params: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<AgentToolResult> {
  const state = getRelayState();
  if (!state || !state.username) {
    return errorResult(
      `${tool} unavailable: no active browser session is connected.`,
    );
  }

  const url = `${state.relayHttpUrl}/api/browser-tool/invoke`;
  const startedAt = Date.now();
  const paramsStr = JSON.stringify(params);
  logger.info(`[browser-tool] → '${tool}' invoke user=${state.username} params=${paramsStr}`);
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${state.token}`,
      },
      body: JSON.stringify({ userId: state.username, tool, params }),
      signal,
    });

    const ms = Date.now() - startedAt;
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      logger.warn(`[browser-tool] ✗ '${tool}' HTTP ${resp.status} (${ms}ms) ${body.slice(0, 200)}`);
      return errorResult(`${tool} failed (HTTP ${resp.status}).`);
    }

    const json = (await resp.json()) as InvokeResponse;
    if (!json.ok || !json.text) {
      logger.warn(`[browser-tool] ✗ '${tool}' no result (${ms}ms) error=${json.error || "(none)"}`);
      return errorResult(json.error || `${tool} returned no result.`);
    }

    const preview = json.text.length > 200 ? json.text.slice(0, 200) + "…" : json.text;
    logger.info(`[browser-tool] ← '${tool}' ok (${ms}ms, ${json.text.length} chars): ${preview}`);
    return { content: [{ type: "text", text: json.text }] };
  } catch (err) {
    const ms = Date.now() - startedAt;
    if ((err as Error).name === "AbortError") {
      logger.info(`[browser-tool] ⨯ '${tool}' aborted (${ms}ms)`);
      return errorResult(`${tool} was cancelled.`);
    }
    const msg = (err as Error).message || "unknown error";
    logger.warn(`[browser-tool] ✗ '${tool}' error (${ms}ms): ${msg}`);
    return errorResult(`${tool} error: ${msg}`);
  }
}

export function errorResult(message: string): AgentToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}
