import { postRespond } from "./http-client.js";
import type { Log, RelayState, StreamDeliveryState } from "./types.js";

export function buildReplyOptions(state: RelayState, requestId: string, log: Log, streamState: StreamDeliveryState) {
  let lastPartialText = "";

  return {
    onPartialReply: async (payload: { text?: string }) => {
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
      await postRespond(state, { requestId, type: "chunk", text }, log);
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
