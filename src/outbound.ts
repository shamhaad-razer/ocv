import { randomUUID } from "node:crypto";
import { loadOutboundMedia, mediaKindFromMime } from "./media.js";
import { getActiveRequest } from "./state.js";
import { safeSend, sendSseText } from "./websocket.js";
import type { OutboundMediaContext } from "./types.js";

export const outboundAdapter = {
  deliveryMode: "direct",
  textChunkLimit: 4000,

  sendText: async (ctx: { to: string; text: string; cfg?: unknown; accountId?: string | null }) => {
    const text = ctx.text || "";
    const req = getActiveRequest();
    if (req && req.ws && text) {
      req.log.info(`[cloud-relay] outbound.sendText: len=${text.length} text="${text.slice(0, 80)}"`);
      sendSseText(req.ws, req.requestId, text, req.log);
    } else {
      console.log(`[cloud-relay] outbound.sendText MISSED: activeRequest=${!!req} text.len=${text.length}`);
    }
    return { ok: true, messageId: `relay-${Date.now()}` };
  },

  sendMedia: async (ctx: OutboundMediaContext) => {
    const req = getActiveRequest();
    if (!req?.ws) {
      console.log("[cloud-relay] outbound.sendMedia MISSED: no active request");
      return { ok: false, messageId: `relay-${Date.now()}` };
    }

    const media = await loadOutboundMedia(ctx);
    req.log.info(
      `[cloud-relay] outbound.sendMedia: filename=${media.filename} mime=${media.mimeType} bytes=${media.buffer.byteLength}`,
    );

    safeSend(req.ws, {
      type: "gateway.event",
      event: "media",
      payload: {
        type: "media",
        kind: mediaKindFromMime(media.mimeType),
        voice: Boolean(ctx.audioAsVoice),
        filename: media.filename,
        mimeType: media.mimeType,
        caption: ctx.text || "",
        data: media.buffer.toString("base64"),
      },
    }, req.log);

    const fallback = mediaKindFromMime(media.mimeType) === "audio"
      ? `\n[Voice note attached: ${media.filename}]\n`
      : `\n[Media attached: ${media.filename}]\n`;
    sendSseText(req.ws, req.requestId, `${ctx.text ? ctx.text + "\n" : ""}${fallback}`, req.log);

    return { ok: true, messageId: `relay-media-${Date.now()}` };
  },
};
