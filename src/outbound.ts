import { postPush, postRespond } from "./http-client.js";
import { getActiveRequest, getRelayState } from "./state.js";
import type { Log } from "./types.js";

const fallbackLog: Log = { info: console.log, warn: console.warn, error: console.error };

export const outboundAdapter = {
  deliveryMode: "direct",
  textChunkLimit: 4000,

  sendText: async (ctx: { to: string; text: string; cfg?: unknown; accountId?: string | null }) => {
    const text = ctx.text || "";
    if (!text) return { ok: true, messageId: `relay-${Date.now()}` };

    const req = getActiveRequest();
    if (req) {
      if (req.streamState.sentFinal) {
        req.log.info(`[cloud-relay] outbound.sendText suppressed after prior delivery: len=${text.length}`);
      } else {
        req.streamState.sentFinal = true;
        await postRespond(req.relayState, { requestId: req.requestId, type: "end", text }, req.log);
      }
      return { ok: true, messageId: `relay-${Date.now()}` };
    }

    // No active request — push async message (cron reminder)
    const relay = getRelayState();
    if (relay) {
      const userId = ctx.to.replace("cloud-relay:", "");
      const runId = `cron-${Date.now()}`;
      const ok = await postPush(relay, {
        userId,
        event: "chat",
        payload: {
          state: "final",
          runId,
          sessionKey: `agent:main:cloud-relay:direct:${userId}`,
          message: { role: "assistant", content: text },
        },
      }, fallbackLog);
      return { ok, messageId: `relay-push-${Date.now()}` };
    }

    fallbackLog.warn(`[cloud-relay] outbound.sendText: no delivery path available`);
    return { ok: false, messageId: `relay-${Date.now()}` };
  },

  sendMedia: async (ctx: { to: string; text?: string }) => {
    // Media push not supported in long-poll mode (would need file upload endpoint)
    fallbackLog.warn(`[cloud-relay] outbound.sendMedia not supported in HTTP mode`);
    return { ok: false, messageId: `relay-media-${Date.now()}` };
  },
};
