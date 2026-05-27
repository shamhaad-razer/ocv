import { postRespond } from "./http-client.js";
import type { Log, RelayState, StreamDeliveryState } from "./types.js";

export function buildReplyOptions(state: RelayState, log: Log, streamState: StreamDeliveryState, respondCtx: { runId: string; sessionKey: string; userId: string }) {
  let lastPartialText = "";

  return {
    onPartialReply: async (payload: { text?: string }) => {
      if (streamState.sentFinal) return;
      const text = payload.text || "";
      let delta = text;
      if (text.startsWith(lastPartialText)) {
        delta = text.slice(lastPartialText.length);
      } else if (text === lastPartialText) {
        return;
      }
      if (!delta) return;
      lastPartialText = text;
      streamState.hadPartial = true;
      await postRespond(state, { type: "chunk", text, ...respondCtx }, log);
    },
    onReplyStart: async () => {},
    onBlockReplyQueued: async () => {},
    onToolStart: async () => {},
    onItemEvent: async () => {},
    onPlanUpdate: async () => {},
    onCommandOutput: async () => {},
    onApprovalEvent: async () => {},
    onPatchSummary: async () => {},
  };
}
