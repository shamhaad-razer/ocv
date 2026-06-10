import { readFileSync, writeFileSync } from "node:fs";
import { CHANNEL_ID } from "./constants.js";
import { resolveDefaultAgentId } from "./config.js";
import { readHistory } from "./history.js";
import { postRespond } from "./http-client.js";
import { buildReplyOptions } from "./reply-options.js";
import { getActiveRequest, rememberSessionKey, setActiveRequest, setCurrentReplyGuidance } from "./state.js";
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

export async function dispatchRequest(
  msg: Record<string, unknown>,
  state: RelayState,
  ctx: GatewayContext,
  log: Log,
  channelRuntime: ChannelRuntime,
): Promise<void> {
  const path = typeof msg.path === "string" ? msg.path : "";
  if (path === "/v1/chat/history") {
    return dispatchHistory(msg, state, ctx, log, channelRuntime);
  }
  return dispatchChat(msg, state, ctx, log, channelRuntime);
}

async function dispatchHistory(
  msg: Record<string, unknown>,
  state: RelayState,
  ctx: GatewayContext,
  log: Log,
  channelRuntime: ChannelRuntime,
): Promise<void> {
  const runId = msg.runId as string;
  const sessionKey = msg.sessionKey as string;
  const userId = (msg.userId as string) || state.username || "browser-user";

  let limit: number | undefined;
  if (typeof msg.body === "string") {
    try {
      const parsed = JSON.parse(Buffer.from(msg.body, "base64").toString());
      if (parsed && typeof parsed.limit === "number") limit = parsed.limit;
    } catch {
      // ignore — limit stays default
    }
  }

  try {
    const messages = await readHistory({
      cfg: ctx.cfg,
      channelRuntime,
      userId,
      limit,
      log,
    });
    log.info(`[cloud-relay] history responded: user=${userId} messages=${messages.length}`);
    await postRespond(state, { type: "history", messages, runId, sessionKey, userId }, log);
  } catch (err) {
    const errMsg = (err as Error).message || "history read failed";
    log.warn(`[cloud-relay] history error: user=${userId} ${errMsg}`);
    await postRespond(state, { type: "error", text: errMsg, runId, sessionKey, userId }, log);
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

  const relayRunId = msg.runId as string;
  const relaySessionKey = msg.sessionKey as string;
  const relayUserId = msg.userId as string;

  const incoming = JSON.parse(Buffer.from(msg.body as string, "base64").toString()) as {
    messages?: Array<{ role?: string; content?: string }>;
    user?: string;
    openclaw?: { source?: string; systemGuidance?: string };
  };
  const messages = incoming.messages || [];
  const lastMessage = messages[messages.length - 1];
  const text = lastMessage?.content || "";
  const userId = relayUserId || incoming.user || state.username || "browser-user";
  // Per-request reply guidance from the server. The before_prompt_build hook
  // appends it to the system prompt; falls back to the built-in default when
  // the server doesn't supply one. Trimmed to ignore empty/whitespace values.
  const serverGuidance = typeof incoming.openclaw?.systemGuidance === "string"
    ? incoming.openclaw.systemGuidance.trim()
    : "";

  const respondCtx = { runId: relayRunId, sessionKey: relaySessionKey, userId };

  if (relaySessionKey) rememberSessionKey(userId, relaySessionKey);

  bootstrapOwnerIfNeeded(ctx.cfg, log);

  if (!text.trim()) {
    log.warn(`[cloud-relay] dispatchChat empty message: user=${userId}`);
    return;
  }

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
    BodyForAgent: text,
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

    const streamState = { sentFinal: false };
    setActiveRequest({ relayState: state, log, streamState, respondCtx });
    // Expose the server-supplied guidance to the before_prompt_build hook for
    // the duration of this dispatch (empty → hook uses its built-in default).
    // Cleared in `finally` so it never leaks into a later turn.
    setCurrentReplyGuidance(serverGuidance || null);
    let hadError = false;
    let deliveredChars = 0;

    try {
      await channelRuntime.reply.dispatchReplyWithBufferedBlockDispatcher({
        ctx: ctxPayload,
        cfg,
        dispatcherOptions: {
          deliver: async (block: { text?: string }) => {
            const blockText = block.text || "";
            if (blockText && !streamState.sentFinal) {
              streamState.sentFinal = true;
              deliveredChars += blockText.length;
              await postRespond(state, { type: "end", text: blockText, ...respondCtx }, log);
            }
            return { ok: true };
          },
          onError: (err: Error | null) => {
            hadError = true;
            log.warn(`[cloud-relay] dispatch error: user=${userId} ${err?.message}`);
            if (!streamState.sentFinal) {
              streamState.sentFinal = true;
              postRespond(state, { type: "error", text: err?.message || "Unknown error", ...respondCtx }, log);
            }
          },
        },
        replyOptions: {
          ...buildReplyOptions(log, { state, respondCtx, streamState }),
          sourceReplyDeliveryMode: "normal",
          suppressDefaultToolProgressMessages: true,
        },
      });
    } finally {
      setCurrentReplyGuidance(null);
      setActiveRequest(null);
    }

    if (!hadError && !streamState.sentFinal) {
      await postRespond(state, { type: "end", ...respondCtx }, log);
    }

    log.info(
      `[cloud-relay] request completed: user=${userId} ` +
      `chars=${deliveredChars} hadError=${hadError} durationMs=${Date.now() - startedAt}`,
    );
  });
}
