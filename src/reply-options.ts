export function buildReplyOptions() {
  return {
    onPartialReply: async () => {},
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
