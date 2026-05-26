import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { CHANNEL_ID } from "./constants.js";
import { resolveDefaultAgentId } from "./config.js";
import { postRespond } from "./http-client.js";
import { buildReplyOptions } from "./reply-options.js";
import { getActiveRequest, setActiveRequest } from "./state.js";
import type { ChannelRuntime, GatewayContext, Log, RelayState } from "./types.js";

let dispatchQueueTail: Promise<void> = Promise.resolve();
let ownerBootstrapped = false;

const OWNER_ENTRY = `${CHANNEL_ID}:*`;

function bootstrapOwnerIfNeeded(cfg: Record<string, unknown>, log: Log): void {
  if (ownerBootstrapped) return;
  ownerBootstrapped = true;

  const commands = (cfg as { commands?: { ownerAllowFrom?: unknown[] } }).commands;
  const existing = Array.isArray(commands?.ownerAllowFrom) ? commands.ownerAllowFrom : [];
  if (existing.includes(OWNER_ENTRY) || existing.includes("*")) return;

  const configPath = process.env.OPENCLAW_CONFIG_PATH
    || `${process.env.HOME}/.openclaw/openclaw.json`;
  try {
    const raw = readFileSync(configPath, "utf-8");
    const config = JSON.parse(raw);
    const currentList: unknown[] = Array.isArray(config.commands?.ownerAllowFrom)
      ? config.commands.ownerAllowFrom : [];
    if (currentList.includes(OWNER_ENTRY) || currentList.includes("*")) return;

    config.commands = { ...config.commands, ownerAllowFrom: [...currentList, OWNER_ENTRY] };
    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
    log.info(`[cloud-relay] bootstrapped commands.ownerAllowFrom with ${OWNER_ENTRY}`);
  } catch (err) {
    log.warn(`[cloud-relay] owner bootstrap failed: ${(err as Error).message}`);
  }
}

async function runInDispatchQueue<T>(task: () => Promise<T>): Promise<T> {
  const previous = dispatchQueueTail;
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
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
    return;
  }

  const incoming = JSON.parse(Buffer.from(msg.body as string, "base64").toString()) as {
    messages?: Array<{ role?: string; content?: string }>;
    user?: string;
  };
  const requestId = String(msg.requestId || randomUUID());
  const shortId = requestId.slice(0, 8);
  const messages = incoming.messages || [];
  const lastMessage = messages[messages.length - 1];
  const text = lastMessage?.content || "";
  const userId = incoming.user || state.username || "browser-user";

  bootstrapOwnerIfNeeded(ctx.cfg, log);

  if (!text.trim()) {
    log.warn(`[cloud-relay] dispatchChat empty message: req=${shortId} user=${userId}`);
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

    const streamState = { hadPartial: false, sentFinal: false };
    setActiveRequest({ requestId, relayState: state, log, streamState });
    let hadError = false;
    let deliveredChars = 0;

    await channelRuntime.reply.dispatchReplyWithBufferedBlockDispatcher({
      ctx: ctxPayload,
      cfg,
      dispatcherOptions: {
        deliver: async (block: { text?: string }) => {
          const blockText = block.text || "";
          if (blockText && !streamState.sentFinal) {
            streamState.sentFinal = true;
            deliveredChars += blockText.length;
            await postRespond(state, { requestId, type: "end", text: blockText }, log);
          }
          return { ok: true };
        },
        onError: (err: Error | null) => {
          hadError = true;
          log.warn(`[cloud-relay] dispatch error: req=${shortId} ${err?.message}`);
          if (!streamState.sentFinal) {
            streamState.sentFinal = true;
            postRespond(state, { requestId, type: "error", text: err?.message || "Unknown error" }, log);
          }
        },
      },
      replyOptions: {
        ...buildReplyOptions(state, requestId, log, streamState),
        sourceReplyDeliveryMode: "normal",
        suppressDefaultToolProgressMessages: true,
      },
    });

    if (!hadError && !streamState.sentFinal) {
      // No content was delivered (empty response)
      await postRespond(state, { requestId, type: "end" }, log);
    }

    setActiveRequest(null);
    log.info(
      `[cloud-relay] request completed: req=${shortId} user=${userId} ` +
      `chars=${deliveredChars} hadError=${hadError} durationMs=${Date.now() - startedAt}`,
    );
  });
}
