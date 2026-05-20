import { loadOutboundMedia, mediaKindFromMime } from "./media.js";
import { getActiveRequest, getLastSentText, setLastSentText } from "./state.js";
import { safeSend, sendSseText } from "./websocket.js";
import type { OutboundMediaContext } from "./types.js";

export const outboundAdapter = {
  deliveryMode: "direct",
  textChunkLimit: 4000,

  sendText: async (ctx: { to: string; text: string; cfg?: unknown; accountId?: string | null }) => {
    const text = ctx.text || "";
    const req = getActiveRequest();
    if (req && req.ws && text) {
      const prev = getLastSentText();
      const delta = text.startsWith(prev) ? text.slice(prev.length) : text;
      if (delta) {
        sendSseText(req.ws, req.requestId, delta, req.log);
        setLastSentText(text);
      }
    }
    return { ok: true, messageId: `relay-${Date.now()}` };
  },

  sendMedia: async (ctx: OutboundMediaContext) => {
    const req = getActiveRequest();
    if (!req?.ws) {
      return { ok: false, messageId: `relay-${Date.now()}` };
    }

    const media = await loadOutboundMedia(ctx);

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
