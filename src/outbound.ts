import { postPush, postRespond } from "./http-client.js";
import { getActiveRequest, getLastSessionKey, getRelayState } from "./state.js";
import type { Log } from "./types.js";

const fallbackLog: Log = { info: console.log, warn: console.warn, error: console.error };

export const outboundAdapter = {
  deliveryMode: "direct",
  textChunkLimit: 4000,

  sendText: async (ctx: { to: string; text: string; cfg?: unknown; accountId?: string | null }) => {
    const text = ctx.text || "";
    fallbackLog.info(`[cloud-relay] outbound.sendText called: to=${ctx.to} len=${text.length}`);
    if (!text) return { ok: true, messageId: `relay-${Date.now()}` };

    const req = getActiveRequest();
    if (req) {
      if (req.streamState.sentFinal) {
        req.log.info(`[cloud-relay] outbound.sendText suppressed after prior delivery: len=${text.length}`);
      } else {
        req.streamState.sentFinal = true;
        req.log.info(`[cloud-relay] outbound.sendText via postRespond: len=${text.length}`);
        await postRespond(req.relayState, { type: "end", text, ...req.respondCtx }, req.log);
      }
      return { ok: true, messageId: `relay-${Date.now()}` };
    }

    // No active request — push async message (cron reminder)
    const relay = getRelayState();
    if (relay) {
      const userId = ctx.to.replace("cloud-relay:", "");
      const runId = `cron-${Date.now()}`;
      const sessionKey = getLastSessionKey(userId) ?? `tunnel:${userId}:default`;
      fallbackLog.info(`[cloud-relay] outbound.sendText via postPush: userId=${userId} runId=${runId} sessionKey=${sessionKey} len=${text.length}`);
      const ok = await postPush(relay, {
        userId,
        event: "chat",
        payload: {
          state: "final",
          runId,
          sessionKey,
          message: { role: "assistant", content: text },
        },
      }, fallbackLog);
      fallbackLog.info(`[cloud-relay] postPush result: ok=${ok} userId=${userId}`);
      return { ok, messageId: `relay-push-${Date.now()}` };
    }

    fallbackLog.warn(`[cloud-relay] outbound.sendText: no delivery path available (no active request and no relay state) to=${ctx.to}`);
    return { ok: false, messageId: `relay-${Date.now()}` };
  },

  sendMedia: async (ctx: { to: string; text?: string }) => {
    // Media push not supported in long-poll mode (would need file upload endpoint)
    fallbackLog.warn(`[cloud-relay] outbound.sendMedia not supported in HTTP mode`);
    return { ok: false, messageId: `relay-media-${Date.now()}` };
  },
};
