import { randomUUID } from "node:crypto";
import { CHANNEL_ID } from "./constants.js";
import { resolveDefaultAgentId } from "./config.js";
import { safeSend, sendSseText } from "./websocket.js";
import { buildReplyOptions } from "./reply-options.js";
import { getActiveRequest, setActiveRequest, getLastSentText, setLastSentText } from "./state.js";
import type { ChannelRuntime, GatewayContext, Log, RelayState } from "./types.js";

let dispatchQueueTail: Promise<void> = Promise.resolve();

async function runInDispatchQueue<T>(
  task: () => Promise<T>,
): Promise<T> {
  const previous = dispatchQueueTail;

  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  dispatchQueueTail = previous.catch(() => undefined).then(() => current);

  await previous.catch(() => undefined);

  try {
    return await task();
  } finally {
    release();
  }
}

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
  const requestId = String(msg.requestId || "unknown");
  const shortId = requestId.slice(0, 8);
  const messages = incoming.messages || [];
  const lastMessage = messages[messages.length - 1];
  const text = lastMessage?.content || "";
  const userId = incoming.user || state.username || "browser-user";

  if (!text.trim()) {
    log.warn(`[cloud-relay] dispatchChat empty message: req=${shortId} user=${userId}`);
    safeSend(state.ws, {
      type: "response", requestId: msg.requestId, statusCode: 400,
      headers: { "content-type": "text/plain" },
      body: Buffer.from("Empty message").toString("base64"),
    }, log);
    return;
  }

  const systemMsg = messages.find((m) => m.role === "system");
  const voicePrefix = systemMsg ? `[${systemMsg.content}]\n\n` : "";
  const startedAt = Date.now();

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

  return runInDispatchQueue(async () => {
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

    const previousRequest = getActiveRequest();
    if (previousRequest) {
      log.warn(
        `[cloud-relay] activeRequest overwrite: newReq=${shortId} ` +
        `previousReq=${String(previousRequest.requestId || "unknown").slice(0, 8)}`,
      );
    }
    setActiveRequest({ requestId: msg.requestId, ws: state.ws, log });
    let hadError = false;
    let deliverCount = 0;
    let deliveredChars = 0;

    await channelRuntime.reply.dispatchReplyWithBufferedBlockDispatcher({
      ctx: ctxPayload,
      cfg,
      dispatcherOptions: {
        deliver: async (block: { text?: string }) => {
          const blockText = block.text || "";
          if (blockText) {
            const prev = getLastSentText();
            const delta = blockText.startsWith(prev) ? blockText.slice(prev.length) : blockText;
            if (delta) {
              deliverCount++;
              deliveredChars += delta.length;
              sendSseText(state.ws, msg.requestId, delta, log);
              setLastSentText(blockText);
            }
          }
          return { ok: true };
        },
        onError: (err: Error | null) => {
          hadError = true;
          log.warn(`[cloud-relay] dispatch error: req=${shortId} ${err?.message}`);
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
    log.info(
      `[cloud-relay] request completed: req=${shortId} user=${userId} ` +
      `delivers=${deliverCount} chars=${deliveredChars} hadError=${hadError} durationMs=${Date.now() - startedAt}`,
    );
    safeSend(state.ws, { type: "response-end", requestId: msg.requestId }, log);
  });
}
