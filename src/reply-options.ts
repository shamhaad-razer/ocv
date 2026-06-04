import { postRespond } from "./http-client.js";
import type { Log, RelayState } from "./types.js";

type PartialReplyPayload = {
  text?: string;
  delta?: string;
  replace?: true;
};

interface PartialStreamCtx {
  state: RelayState;
  respondCtx: { runId: string; sessionKey: string; userId: string };
  streamState: { sentFinal: boolean };
}

export function buildReplyOptions(log?: Log, partialCtx?: PartialStreamCtx) {
  return {
    onPartialReply: async (payload: PartialReplyPayload) => {
      const delta = payload?.delta ?? "";
      const text = payload?.text ?? "";
      log?.info(
        `[cloud-relay] partial reply: deltaChars=${delta.length} textChars=${text.length}` +
          (payload?.replace ? " replace=true" : ""),
      );
      if (!partialCtx || !text || partialCtx.streamState.sentFinal || !log) return;
      await postRespond(
        partialCtx.state,
        { type: "chunk", text, ...partialCtx.respondCtx },
        log,
      );
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
