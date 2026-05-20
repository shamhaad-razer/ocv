// src/constants.ts
var DEFAULT_RELAY_URL = "wss://ocv.razer.ai/_tunnel";
var RECONNECT_DELAYS = [1e3, 2e3, 4e3, 8e3, 16e3, 3e4];
var HEARTBEAT_INTERVAL_MS = 3e4;
var CHANNEL_ID = "cloud-relay";
var DEFAULT_ACCOUNT_ID = "default";
var DEFAULT_AGENT_ID = "main";
var TOKEN_POLL_INTERVAL_MS = 5e3;
var MAX_OUTBOUND_MEDIA_BYTES = 15 * 1024 * 1024;

// src/config.ts
function resolveChannelConfig(cfg) {
  const channels = cfg?.channels;
  const channelSection = channels?.["cloud-relay"];
  const plugins = cfg?.plugins;
  const entries = plugins?.entries;
  const pluginSection = entries?.["cloud-relay"]?.config;
  return channelSection || pluginSection || {};
}
function resolveToken(cfg) {
  return resolveChannelConfig(cfg)?.token || process.env.CLOUD_RELAY_TOKEN || "";
}
function resolveRelayUrl(cfg) {
  return resolveChannelConfig(cfg)?.relayUrl || DEFAULT_RELAY_URL;
}
function normalizeAgentId(value) {
  const normalized = (value ?? "").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+/g, "").replace(/-+$/g, "");
  return normalized || DEFAULT_AGENT_ID;
}
function resolveDefaultAgentId(cfg) {
  const agentsCfg = cfg?.agents;
  const agents = Array.isArray(agentsCfg?.list) ? agentsCfg.list : [];
  const chosen = (agents.find((agent) => agent?.default) ?? agents[0])?.id;
  return normalizeAgentId(chosen);
}
function resolveAccount(cfg, accountId) {
  const token = resolveToken(cfg);
  const relayUrl = resolveRelayUrl(cfg);
  return {
    accountId: accountId || DEFAULT_ACCOUNT_ID,
    enabled: Boolean(token),
    configured: Boolean(token),
    token,
    relayUrl
  };
}

// src/dispatch.ts
import { randomUUID as randomUUID3 } from "node:crypto";

// src/websocket.ts
import { randomUUID } from "node:crypto";
function safeSend(ws, msg, log) {
  try {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  } catch (err) {
    log.warn(`[cloud-relay] safeSend failed: ${err.message}`);
  }
}
function sendSseText(ws, requestId, text, log) {
  if (!text) return;
  const sseChunk = `data: ${JSON.stringify({
    id: `chatcmpl-${randomUUID()}`,
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta: { content: text }, finish_reason: null }]
  })}

`;
  safeSend(ws, { type: "response-chunk", requestId, data: Buffer.from(sseChunk).toString("base64") }, log);
}
function startHeartbeat(state, log) {
  if (state.heartbeatTimer) {
    clearInterval(state.heartbeatTimer);
    state.heartbeatTimer = null;
  }
  state.heartbeatTimer = setInterval(
    () => safeSend(state.ws, { type: "ping", ts: Date.now() }, log),
    HEARTBEAT_INTERVAL_MS
  );
}
function scheduleReconnect(state, connect, log) {
  if (state.stopped || state.reconnectTimer) return;
  const delay = RECONNECT_DELAYS[Math.min(state.reconnectAttempt, RECONNECT_DELAYS.length - 1)];
  state.reconnectAttempt++;
  log.info(`[cloud-relay] Reconnecting in ${delay / 1e3}s (attempt ${state.reconnectAttempt})...`);
  state.reconnectTimer = setTimeout(() => {
    state.reconnectTimer = null;
    connect();
  }, delay);
}
function teardown(state) {
  state.stopped = true;
  if (state.reconnectTimer) {
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
  }
  if (state.tokenPollTimer) {
    clearInterval(state.tokenPollTimer);
    state.tokenPollTimer = null;
  }
  if (state.heartbeatTimer) {
    clearInterval(state.heartbeatTimer);
    state.heartbeatTimer = null;
  }
  if (state.ws) {
    state.ws.close(1e3, "shutdown");
    state.ws = null;
  }
}

// src/reply-options.ts
import { randomUUID as randomUUID2 } from "node:crypto";
function buildReplyOptions(state, requestId, log) {
  function forwardEvent(type, payload) {
    safeSend(state.ws, { type: "gateway.event", event: "activity", payload: { type, ...payload } }, log);
  }
  return {
    onPartialReply: async (payload) => {
      const text = payload.text || "";
      if (!text) return;
      const prev = getLastSentText();
      const delta = text.startsWith(prev) ? text.slice(prev.length) : text;
      if (!delta) return;
      setLastSentText(text);
      const sseChunk = `data: ${JSON.stringify({
        id: `chatcmpl-${randomUUID2()}`,
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: { content: delta }, finish_reason: null }]
      })}

`;
      safeSend(state.ws, { type: "response-chunk", requestId, data: Buffer.from(sseChunk).toString("base64") }, log);
    },
    onReplyStart: async () => {
    },
    onBlockReplyQueued: async () => {
    },
    onToolStart: async (p) => {
      forwardEvent("tool_start", { name: p.name, phase: p.phase, args: p.args });
    },
    onItemEvent: async (p) => {
      forwardEvent("item", { kind: p.kind, title: p.title, name: p.name, phase: p.phase, status: p.status, summary: p.summary, progressText: p.progressText });
    },
    onPlanUpdate: async (p) => {
      forwardEvent("plan", { phase: p.phase, title: p.title, explanation: p.explanation, steps: p.steps });
    },
    onCommandOutput: async (p) => {
      forwardEvent("command_output", { phase: p.phase, title: p.title, name: p.name, status: p.status, exitCode: p.exitCode });
    },
    onApprovalEvent: async (p) => {
      forwardEvent("approval", { phase: p.phase, title: p.title, command: p.command, reason: p.reason, message: p.message });
    },
    onPatchSummary: async (p) => {
      forwardEvent("patch", { phase: p.phase, title: p.title, name: p.name, added: p.added, modified: p.modified, deleted: p.deleted, summary: p.summary });
    }
  };
}

// src/state.ts
var pluginRuntime = null;
var gatewayChannelRuntime = null;
var activeRequest = null;
var lastSentText = "";
function setPluginRuntime(rt) {
  pluginRuntime = rt;
}
function setGatewayChannelRuntime(rt) {
  gatewayChannelRuntime = rt;
}
function getActiveRequest() {
  return activeRequest;
}
function setActiveRequest(req) {
  activeRequest = req;
  lastSentText = "";
}
function getLastSentText() {
  return lastSentText;
}
function setLastSentText(text) {
  lastSentText = text;
}
function resolveChannelRuntime(ctx) {
  return gatewayChannelRuntime || pluginRuntime?.channel || ctx?.channelRuntime || null;
}

// src/dispatch.ts
var dispatchQueueTail = Promise.resolve();
async function runInDispatchQueue(task) {
  const previous = dispatchQueueTail;
  let release;
  const current = new Promise((resolve2) => {
    release = resolve2;
  });
  dispatchQueueTail = previous.catch(() => void 0).then(() => current);
  await previous.catch(() => void 0);
  try {
    return await task();
  } finally {
    release();
  }
}
async function dispatchChat(msg, state, ctx, log, channelRuntime) {
  if (!channelRuntime) {
    log.warn("[cloud-relay] channelRuntime not ready, rejecting request");
    safeSend(state.ws, {
      type: "response",
      requestId: msg.requestId,
      statusCode: 503,
      headers: { "content-type": "text/plain" },
      body: Buffer.from("Channel not ready").toString("base64")
    }, log);
    return;
  }
  const incoming = JSON.parse(Buffer.from(msg.body, "base64").toString());
  const requestId = String(msg.requestId || "unknown");
  const shortId = requestId.slice(0, 8);
  const messages = incoming.messages || [];
  const lastMessage = messages[messages.length - 1];
  const text = lastMessage?.content || "";
  const userId = incoming.user || state.username || "browser-user";
  if (!text.trim()) {
    log.warn(`[cloud-relay] dispatchChat empty message: req=${shortId} user=${userId}`);
    safeSend(state.ws, {
      type: "response",
      requestId: msg.requestId,
      statusCode: 400,
      headers: { "content-type": "text/plain" },
      body: Buffer.from("Empty message").toString("base64")
    }, log);
    return;
  }
  const systemMsg = messages.find((m) => m.role === "system");
  const voicePrefix = systemMsg ? `[${systemMsg.content}]

` : "";
  const startedAt = Date.now();
  const cfg = ctx.cfg;
  const agentId = resolveDefaultAgentId(cfg);
  const sessionKey = channelRuntime.routing.buildAgentSessionKey({
    agentId,
    channel: CHANNEL_ID,
    peer: { id: userId, type: "direct" },
    dmScope: cfg?.session?.dmScope || "per-channel-peer"
  });
  const storePath = channelRuntime.session.resolveStorePath(
    cfg?.session?.store,
    { agentId }
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
    CommandAuthorized: true
  };
  return runInDispatchQueue(async () => {
    await channelRuntime.session.recordInboundSession({
      storePath,
      sessionKey,
      ctx: ctxPayload,
      onRecordError: (err) => {
        log.warn(`[cloud-relay] session record error: ${err.message}`);
      }
    });
    safeSend(state.ws, {
      type: "response-start",
      requestId: msg.requestId,
      statusCode: 200,
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" }
    }, log);
    const previousRequest = getActiveRequest();
    if (previousRequest) {
      log.warn(
        `[cloud-relay] activeRequest overwrite: newReq=${shortId} previousReq=${String(previousRequest.requestId || "unknown").slice(0, 8)}`
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
        deliver: async (block) => {
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
        onError: (err) => {
          hadError = true;
          log.warn(`[cloud-relay] dispatch error: req=${shortId} ${err?.message}`);
          const errChunk = `data: ${JSON.stringify({
            error: { message: err?.message || "Unknown error", type: "server_error" }
          })}

`;
          safeSend(state.ws, { type: "response-chunk", requestId: msg.requestId, data: Buffer.from(errChunk).toString("base64") }, log);
        }
      },
      replyOptions: {
        ...buildReplyOptions(state, msg.requestId, log),
        sourceReplyDeliveryMode: "normal",
        suppressDefaultToolProgressMessages: true
      }
    });
    if (!hadError) {
      const doneChunk = `data: ${JSON.stringify({
        id: `chatcmpl-${randomUUID3()}`,
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }]
      })}

data: [DONE]

`;
      safeSend(state.ws, { type: "response-chunk", requestId: msg.requestId, data: Buffer.from(doneChunk).toString("base64") }, log);
    }
    setActiveRequest(null);
    log.info(
      `[cloud-relay] request completed: req=${shortId} user=${userId} delivers=${deliverCount} chars=${deliveredChars} hadError=${hadError} durationMs=${Date.now() - startedAt}`
    );
    safeSend(state.ws, { type: "response-end", requestId: msg.requestId }, log);
  });
}

// src/gateway.ts
async function startGatewayAccount(ctx) {
  const log = ctx.log || { info: console.log, warn: console.warn, error: console.error };
  const account = ctx.account || resolveAccount(ctx.cfg, ctx.accountId);
  if (!account.token) {
    log.error("[cloud-relay] No token configured.");
    log.error("[cloud-relay] 1. Sign in at https://ocv.razer.ai and copy your token");
    log.error("[cloud-relay] 2. Add it to ~/.openclaw/openclaw.json:");
    log.error('[cloud-relay]    channels.cloud-relay.token = "your-token"');
    throw new Error("Cloud Relay token not configured");
  }
  setGatewayChannelRuntime(ctx.channelRuntime || null);
  if (!ctx.channelRuntime) {
    log.warn("[cloud-relay] channelRuntime not available, SDK dispatch will not work");
  }
  const state = {
    ws: null,
    connecting: false,
    stopped: false,
    reconnectAttempt: 0,
    reconnectTimer: null,
    heartbeatTimer: null,
    tokenPollTimer: null,
    lastKnownToken: account.token,
    username: null
  };
  function connect() {
    if (state.ws || state.connecting || state.stopped) return;
    state.connecting = true;
    const token = resolveToken(ctx.cfg);
    if (!token) {
      state.connecting = false;
      log.warn("[cloud-relay] No token configured.");
      return;
    }
    const relayUrl = resolveRelayUrl(ctx.cfg);
    log.info(`[cloud-relay] Connecting to ${relayUrl}...`);
    let thisWs;
    try {
      thisWs = new WebSocket(`${relayUrl}?token=${token}`);
    } catch (err) {
      state.connecting = false;
      log.error(`[cloud-relay] Connection failed: ${err.message}`);
      scheduleReconnect(state, connect, log);
      return;
    }
    state.ws = thisWs;
    thisWs.addEventListener("open", () => {
      if (state.ws !== thisWs) return;
      state.connecting = false;
      state.reconnectAttempt = 0;
      startHeartbeat(state, log);
      log.info("[cloud-relay] Connected to relay server");
    });
    thisWs.addEventListener("message", (event) => {
      if (state.ws !== thisWs) return;
      let parsedMsg;
      try {
        parsedMsg = JSON.parse(typeof event.data === "string" ? event.data : String(event.data));
      } catch {
        return;
      }
      if (parsedMsg.type === "error") {
        log.error(`[cloud-relay] Server error: ${parsedMsg.message}`);
        return;
      }
      if (parsedMsg.type === "pong") return;
      if (parsedMsg.type === "registered") {
        state.username = parsedMsg.username;
        const host = relayUrl.replace("ws://", "").replace("wss://", "").replace("/_tunnel", "");
        log.info("[cloud-relay] Tunnel established!");
        log.info(`[cloud-relay]   User:     ${state.username}`);
        log.info(`[cloud-relay]   Chat URL: https://${host}/`);
        return;
      }
      if (parsedMsg.type === "request") {
        const reqId = String(parsedMsg.requestId || "unknown").slice(0, 8);
        const channelRuntime = resolveChannelRuntime(ctx);
        if (!channelRuntime) {
          log.warn(`[cloud-relay] tunnel request rejected, channelRuntime missing: req=${reqId}`);
          safeSend(state.ws, {
            type: "response",
            requestId: parsedMsg.requestId,
            statusCode: 503,
            headers: { "content-type": "text/plain" },
            body: Buffer.from("Channel not ready").toString("base64")
          }, log);
          return;
        }
        dispatchChat(parsedMsg, state, ctx, log, channelRuntime).catch((err) => {
          log.error(`[cloud-relay] dispatch error: req=${reqId} ${err.message}`);
          safeSend(state.ws, {
            type: "response",
            requestId: parsedMsg.requestId,
            statusCode: 502,
            headers: { "content-type": "text/plain" },
            body: Buffer.from(`Dispatch failed - ${err.message}`).toString("base64")
          }, log);
        });
      }
    });
    thisWs.addEventListener("close", (event) => {
      if (state.ws !== thisWs) return;
      log.info(`[cloud-relay] Disconnected: ${event.code} ${event.reason || ""}`);
      state.ws = null;
      state.connecting = false;
      if (state.heartbeatTimer) {
        clearInterval(state.heartbeatTimer);
        state.heartbeatTimer = null;
      }
      if (event.code === 4e3 || event.code === 4001 || event.code === 4003) {
        state.stopped = true;
        return;
      }
      if (!state.stopped) scheduleReconnect(state, connect, log);
    });
    thisWs.addEventListener("error", () => {
      if (state.ws !== thisWs) return;
      log.warn("[cloud-relay] WebSocket error");
    });
  }
  function watchConfigForTokenChange() {
    state.lastKnownToken = account.token;
    state.tokenPollTimer = setInterval(() => {
      try {
        const newToken = resolveToken(ctx.cfg);
        if (newToken && newToken !== state.lastKnownToken) {
          state.lastKnownToken = newToken;
          log.info("[cloud-relay] Token changed, reconnecting...");
          state.stopped = false;
          if (state.ws) {
            state.ws.close(1e3, "token changed");
            state.ws = null;
          }
          state.connecting = false;
          if (state.heartbeatTimer) {
            clearInterval(state.heartbeatTimer);
            state.heartbeatTimer = null;
          }
          if (state.reconnectTimer) {
            clearTimeout(state.reconnectTimer);
            state.reconnectTimer = null;
          }
          state.reconnectAttempt = 0;
          connect();
        }
      } catch (err) {
        log.warn(`[cloud-relay] Token poll error: ${err.message}`);
      }
    }, TOKEN_POLL_INTERVAL_MS);
  }
  log.info(`[cloud-relay] Starting gateway for account "${account.accountId}"`);
  connect();
  watchConfigForTokenChange();
  return new Promise((resolve2) => {
    if (ctx.abortSignal) {
      ctx.abortSignal.addEventListener("abort", () => {
        teardown(state);
        resolve2();
      });
    }
  });
}

// src/media.ts
import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
function mimeTypeFromPath(filePath) {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".mp3")) return "audio/mpeg";
  if (lower.endsWith(".m4a") || lower.endsWith(".mp4")) return "audio/mp4";
  if (lower.endsWith(".wav")) return "audio/wav";
  if (lower.endsWith(".aiff") || lower.endsWith(".aif")) return "audio/aiff";
  if (lower.endsWith(".ogg") || lower.endsWith(".oga")) return "audio/ogg";
  if (lower.endsWith(".webm")) return "audio/webm";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  return "application/octet-stream";
}
function mediaKindFromMime(mimeType) {
  if (mimeType.startsWith("audio/")) return "audio";
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("video/")) return "video";
  return "file";
}
function parseDataUrl(mediaUrl) {
  const match = /^data:([^;,]+)?(?:;[^,]*)?;base64,(.*)$/i.exec(mediaUrl);
  if (!match) return null;
  return {
    buffer: Buffer.from(match[2] || "", "base64"),
    mimeType: match[1] || "application/octet-stream"
  };
}
async function loadOutboundMedia(ctx) {
  const mediaUrl = ctx.mediaUrl || "";
  if (!mediaUrl) throw new Error("No mediaUrl provided");
  const dataUrl = parseDataUrl(mediaUrl);
  if (dataUrl) {
    return { ...dataUrl, filename: "attachment" };
  }
  if (/^https?:\/\//i.test(mediaUrl)) {
    const response = await fetch(mediaUrl);
    if (!response.ok) throw new Error(`Media fetch failed: ${response.status}`);
    const buffer2 = Buffer.from(await response.arrayBuffer());
    if (buffer2.byteLength > MAX_OUTBOUND_MEDIA_BYTES) {
      throw new Error("Media file is too large for cloud-relay websocket delivery");
    }
    const urlPath = new URL(mediaUrl).pathname;
    return {
      buffer: buffer2,
      mimeType: response.headers.get("content-type") || mimeTypeFromPath(urlPath),
      filename: basename(urlPath) || "attachment"
    };
  }
  const read = ctx.mediaAccess?.readFile || ctx.mediaReadFile || (async (filePath) => await readFile(filePath));
  const physicalPath = mediaUrl.startsWith("file://") ? new URL(mediaUrl) : ctx.mediaAccess?.workspaceDir && !mediaUrl.startsWith("/") ? resolve(ctx.mediaAccess.workspaceDir, mediaUrl) : mediaUrl;
  const buffer = await read(physicalPath instanceof URL ? physicalPath.pathname : physicalPath);
  if (buffer.byteLength > MAX_OUTBOUND_MEDIA_BYTES) {
    throw new Error("Media file is too large for cloud-relay websocket delivery");
  }
  const filename = basename(physicalPath instanceof URL ? physicalPath.pathname : physicalPath) || "attachment";
  return { buffer, mimeType: mimeTypeFromPath(filename), filename };
}

// src/outbound.ts
var outboundAdapter = {
  deliveryMode: "direct",
  textChunkLimit: 4e3,
  sendText: async (ctx) => {
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
  sendMedia: async (ctx) => {
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
        data: media.buffer.toString("base64")
      }
    }, req.log);
    const fallback = mediaKindFromMime(media.mimeType) === "audio" ? `
[Voice note attached: ${media.filename}]
` : `
[Media attached: ${media.filename}]
`;
    sendSseText(req.ws, req.requestId, `${ctx.text ? ctx.text + "\n" : ""}${fallback}`, req.log);
    return { ok: true, messageId: `relay-media-${Date.now()}` };
  }
};

// src/plugin.ts
var cloudRelayPlugin = {
  id: CHANNEL_ID,
  meta: {
    id: CHANNEL_ID,
    label: "Cloud Relay",
    selectionLabel: "Cloud Relay (Browser)",
    blurb: "Browser chat sessions via Cloud Relay tunnel",
    order: 90,
    markdownCapable: true,
    exposure: { configured: true, setup: false, docs: false }
  },
  capabilities: {
    chatTypes: ["direct"],
    media: true,
    reactions: false,
    edit: false,
    unsend: false,
    reply: false,
    threads: false,
    polls: false,
    nativeCommands: false
  },
  config: {
    listAccountIds: () => [DEFAULT_ACCOUNT_ID],
    resolveAccount: (cfg, accountId) => resolveAccount(cfg, accountId),
    isEnabled: (account) => Boolean(account?.enabled),
    isConfigured: (account) => Boolean(account?.configured)
  },
  gateway: {
    startAccount: async (ctx) => startGatewayAccount(ctx),
    stopAccount: async (ctx) => {
      const log = ctx?.log || { info: console.log, warn: console.warn, error: console.error };
      log.info("[cloud-relay] channel stopAccount");
    }
  },
  outbound: outboundAdapter
};

// src/index.ts
var index_default = {
  id: CHANNEL_ID,
  name: "Cloud Relay Tunnel",
  description: "Browser chat sessions via Cloud Relay tunnel",
  register(api) {
    setPluginRuntime(api.runtime || null);
    api.registerChannel({ plugin: cloudRelayPlugin });
  }
};
export {
  index_default as default
};
