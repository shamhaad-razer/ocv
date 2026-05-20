import { randomUUID } from "node:crypto";
import { safeSend } from "./websocket.js";
import { getLastSentText, setLastSentText } from "./state.js";
import type { Log, RelayState } from "./types.js";

export function buildReplyOptions(state: RelayState, requestId: unknown, log: Log) {
  function forwardEvent(type: string, payload: Record<string, unknown>) {
    safeSend(state.ws, { type: "gateway.event", event: "activity", payload: { type, ...payload } }, log);
  }

  return {
    onPartialReply: async (payload: { text?: string }) => {
      const text = payload.text || "";
      if (!text) return;
      const prev = getLastSentText();
      const delta = text.startsWith(prev) ? text.slice(prev.length) : text;
      if (!delta) return;
      setLastSentText(text);
      const sseChunk = `data: ${JSON.stringify({
        id: `chatcmpl-${randomUUID()}`,
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: { content: delta }, finish_reason: null }],
      })}\n\n`;
      safeSend(state.ws, { type: "response-chunk", requestId, data: Buffer.from(sseChunk).toString("base64") }, log);
    },
    onReplyStart: async () => {},
    onBlockReplyQueued: async () => {},
    onToolStart: async (p: Record<string, unknown>) => {
      forwardEvent("tool_start", { name: p.name, phase: p.phase, args: p.args });
    },
    onItemEvent: async (p: Record<string, unknown>) => {
      forwardEvent("item", { kind: p.kind, title: p.title, name: p.name, phase: p.phase, status: p.status, summary: p.summary, progressText: p.progressText });
    },
    onPlanUpdate: async (p: Record<string, unknown>) => {
      forwardEvent("plan", { phase: p.phase, title: p.title, explanation: p.explanation, steps: p.steps });
    },
    onCommandOutput: async (p: Record<string, unknown>) => {
      forwardEvent("command_output", { phase: p.phase, title: p.title, name: p.name, status: p.status, exitCode: p.exitCode });
    },
    onApprovalEvent: async (p: Record<string, unknown>) => {
      forwardEvent("approval", { phase: p.phase, title: p.title, command: p.command, reason: p.reason, message: p.message });
    },
    onPatchSummary: async (p: Record<string, unknown>) => {
      forwardEvent("patch", { phase: p.phase, title: p.title, name: p.name, added: p.added, modified: p.modified, deleted: p.deleted, summary: p.summary });
    },
  };
}
