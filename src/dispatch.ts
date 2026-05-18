import { randomUUID } from "node:crypto";
import { CHANNEL_ID } from "./constants.js";
import { resolveDefaultAgentId } from "./config.js";
import { safeSend, sendSseText } from "./websocket.js";
import { buildReplyOptions } from "./reply-options.js";
import { getActiveRequest, setActiveRequest } from "./state.js";
import type { ChannelRuntime, GatewayContext, Log, RelayState } from "./types.js";

export async function dispatchChat(
  msg: Record<string, unknown>,
  state: RelayState,
  ctx: GatewayContext,
  log: Log,
  channelRuntime: ChannelRuntime,
): Promise<void> {
  if (!channelRuntime) {
    log.warn("[cloud-relay] channelRuntime not ready, rejecting request");
    safeSend(state.ws, {
      type: "response", requestId: msg.requestId, statusCode: 503,
      headers: { "content-type": "text/plain" },
      body: Buffer.from("Channel not ready").toString("base64"),
    }, log);
    return;
  }

  const incoming = JSON.parse(Buffer.from(msg.body as string, "base64").toString()) as {
    messages?: Array<{ role?: string; content?: string }>;
    user?: string;
  };
  const messages = incoming.messages || [];
  const lastMessage = messages[messages.length - 1];
  const text = lastMessage?.content || "";
  const userId = incoming.user || state.username || "browser-user";

  if (!text.trim()) {
    safeSend(state.ws, {
      type: "response", requestId: msg.requestId, statusCode: 400,
      headers: { "content-type": "text/plain" },
      body: Buffer.from("Empty message").toString("base64"),
    }, log);
    return;
  }

  const systemMsg = messages.find((m) => m.role === "system");
  const voicePrefix = systemMsg ? `[${systemMsg.content}]\n\n` : "";

  const cfg = ctx.cfg;
  const agentId = resolveDefaultAgentId(cfg);

  const sessionKey = channelRuntime.routing.buildAgentSessionKey({
    agentId,
    channel: CHANNEL_ID,
    peer: { id: userId, type: "direct" },
    dmScope: (cfg?.session as Record<string, unknown>)?.dmScope || "per-channel-peer",
  });

  const storePath = channelRuntime.session.resolveStorePath(
    (cfg?.session as Record<string, unknown>)?.store as string | undefined,
    { agentId },
  );

  const ctxPayload = {
    SessionKey: sessionKey,
    Body: text,
    BodyForAgent: voicePrefix + text,
    RawBody: text,
    CommandBody: text,
    From: `${CHANNEL_ID}:${userId}`,
    To: `${CHANNEL_ID}:${userId}`,
    Provider: CHANNEL_ID,
    Surface: CHANNEL_ID,
    ChatType: "direct",
    CommandAuthorized: true,
  };

  log.info(`[cloud-relay] Inbound message ${CHANNEL_ID}:${userId} (direct, ${text.length} chars)`);

  await channelRuntime.session.recordInboundSession({
    storePath,
    sessionKey,
    ctx: ctxPayload,
    onRecordError: (err: Error) => {
      log.warn(`[cloud-relay] session record error: ${err.message}`);
    },
  });

  safeSend(state.ws, {
    type: "response-start", requestId: msg.requestId,
    statusCode: 200,
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
  }, log);

  setActiveRequest({ requestId: msg.requestId, ws: state.ws, log });
  let hadError = false;

  await channelRuntime.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg,
    dispatcherOptions: {
      deliver: async (block: { text?: string }) => {
        const blockText = block.text || "";
        if (blockText) {
          sendSseText(state.ws, msg.requestId, blockText, log);
        }
        return { ok: true };
      },
      onError: (err: Error | null) => {
        hadError = true;
        log.warn(`[cloud-relay] dispatch error: ${err?.message}`);
        const errChunk = `data: ${JSON.stringify({
          error: { message: err?.message || "Unknown error", type: "server_error" },
        })}\n\n`;
        safeSend(state.ws, { type: "response-chunk", requestId: msg.requestId, data: Buffer.from(errChunk).toString("base64") }, log);
      },
    },
    replyOptions: {
      ...buildReplyOptions(state, msg.requestId, log),
      sourceReplyDeliveryMode: "normal",
      suppressDefaultToolProgressMessages: true,
    },
  });

  if (!hadError) {
    const doneChunk = `data: ${JSON.stringify({
      id: `chatcmpl-${randomUUID()}`,
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    })}\n\ndata: [DONE]\n\n`;
    safeSend(state.ws, { type: "response-chunk", requestId: msg.requestId, data: Buffer.from(doneChunk).toString("base64") }, log);
  }

  setActiveRequest(null);
  safeSend(state.ws, { type: "response-end", requestId: msg.requestId }, log);
  log.info(`[cloud-relay] ${msg.method} ${msg.path} 200 user=${userId}`);
}
