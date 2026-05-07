const { randomUUID } = require("node:crypto");

const DEFAULT_RELAY_URL = "wss://opencl2.prp.razer.com/_tunnel";
const RECONNECT_DELAYS = [1000, 2000, 4000, 8000, 16000, 30000];
const HEARTBEAT_INTERVAL_MS = 30000;
const CHANNEL_ID = "cloud-relay";
const DEFAULT_ACCOUNT_ID = "default";

module.exports = {
  id: "cloud-relay",
  name: "Cloud Relay Tunnel",

  register(api) {
    const log = api.logger || { info: console.log, warn: console.warn, error: console.error };
    let stopped = false;

    // --- Config resolution ---

    function pluginConfig() {
      return api.config?.plugins?.entries?.["cloud-relay"]?.config || api.config || {};
    }

    function resolveRelayUrl() {
      return pluginConfig().relayUrl || DEFAULT_RELAY_URL;
    }

    function resolveToken() {
      return pluginConfig().token || "";
    }

    function resolveDefaultAgentId() {
      const agents = currentCfg?.agents?.list || [];
      const defaultAgent = agents.find((a) => a.default);
      return defaultAgent?.id || agents[0]?.id || "default";
    }

    // --- State ---
    let runtimeApi = api;
    let channelRuntime = null;
    let currentCfg = null;
    let ws = null;
    let connecting = false;
    let reconnectAttempt = 0;
    let reconnectTimer = null;
    let heartbeatTimer = null;
    let lastKnownToken = null;
    let tokenPollTimer = null;
    let username = null;

    // ============================================================
    // Cloud Relay WebSocket Connection
    // ============================================================

    function connect() {
      if (ws || connecting || stopped) return;
      connecting = true;

      const token = resolveToken();
      if (!token) {
        connecting = false;
        log.warn("[cloud-relay] No token configured.");
        log.warn("[cloud-relay] 1. Sign in at https://opencl2.prp.razer.com and copy your token");
        log.warn('[cloud-relay] 2. Add it to ~/.openclaw/openclaw.json:');
        log.warn('[cloud-relay]    plugins.entries.cloud-relay.config.token = "your-token"');
        return;
      }

      const relayUrl = resolveRelayUrl();
      log.info(`[cloud-relay] Connecting to ${relayUrl}...`);

      let thisWs;
      try {
        thisWs = new WebSocket(`${relayUrl}?token=${token}`);
      } catch (err) {
        connecting = false;
        log.error(`[cloud-relay] Connection failed: ${err.message}`);
        scheduleReconnect();
        return;
      }

      ws = thisWs;

      thisWs.addEventListener("open", () => {
        if (ws !== thisWs) return;
        connecting = false;
        reconnectAttempt = 0;
        startHeartbeat();
        log.info("[cloud-relay] Connected to relay server");
      });

      thisWs.addEventListener("message", (event) => {
        if (ws !== thisWs) return;
        let msg;
        try { msg = JSON.parse(typeof event.data === "string" ? event.data : event.data.toString()); } catch { return; }

        if (msg.type === "error") { log.error(`[cloud-relay] Server error: ${msg.message}`); return; }
        if (msg.type === "pong") return;

        if (msg.type === "registered") {
          username = msg.username;
          const host = relayUrl.replace("ws://", "").replace("wss://", "").replace("/_tunnel", "");
          log.info("[cloud-relay] Tunnel established!");
          log.info(`[cloud-relay]   User:     ${username}`);
          log.info(`[cloud-relay]   Chat URL: https://${host}/chat/${username}`);
          return;
        }

        if (msg.type === "request") {
          handleIncomingRequest(msg);
        }
      });

      thisWs.addEventListener("close", (event) => {
        if (ws !== thisWs) return;
        log.info(`[cloud-relay] Disconnected: ${event.code} ${event.reason || ""}`);
        ws = null;
        connecting = false;
        stopHeartbeat();
        if (event.code === 4003 || event.code === 4001) {
          stopped = true;
          return;
        }
        if (!stopped) scheduleReconnect();
      });

      thisWs.addEventListener("error", () => {
        if (ws !== thisWs) return;
        log.warn("[cloud-relay] WebSocket error");
      });
    }

    function safeSend(msg) {
      try {
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
      } catch {}
    }

    function startHeartbeat() {
      stopHeartbeat();
      heartbeatTimer = setInterval(() => safeSend({ type: "ping", ts: Date.now() }), HEARTBEAT_INTERVAL_MS);
    }

    function stopHeartbeat() {
      if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
    }

    function scheduleReconnect() {
      if (stopped || reconnectTimer) return;
      const delay = RECONNECT_DELAYS[Math.min(reconnectAttempt, RECONNECT_DELAYS.length - 1)];
      reconnectAttempt++;
      log.info(`[cloud-relay] Reconnecting in ${delay / 1000}s (attempt ${reconnectAttempt})...`);
      reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, delay);
    }

    function watchConfigForTokenChange() {
      lastKnownToken = resolveToken();
      tokenPollTimer = setInterval(() => {
        try {
          const newToken = resolveToken();
          if (newToken && newToken !== lastKnownToken) {
            lastKnownToken = newToken;
            log.info("[cloud-relay] Token changed, reconnecting...");
            stopped = false;
            if (ws) { ws.close(1000, "token changed"); ws = null; }
            connecting = false;
            stopHeartbeat();
            if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
            reconnectAttempt = 0;
            connect();
          }
        } catch {}
      }, 5000);
    }

    // ============================================================
    // Incoming Request Handler (SDK dispatch)
    // ============================================================

    function handleIncomingRequest(msg) {
      if (!channelRuntime) {
        log.warn("[cloud-relay] channelRuntime not ready, rejecting request");
        safeSend({ type: "response", requestId: msg.requestId, statusCode: 503,
          headers: { "content-type": "text/plain" },
          body: Buffer.from("Channel not ready").toString("base64") });
        return;
      }

      dispatchChat(msg).catch((err) => {
        log.error(`[cloud-relay] dispatch error: ${err.message}`);
        safeSend({ type: "response", requestId: msg.requestId, statusCode: 502,
          headers: { "content-type": "text/plain" },
          body: Buffer.from(`Dispatch failed - ${err.message}`).toString("base64") });
      });
    }

    async function dispatchChat(msg) {
      const incoming = JSON.parse(Buffer.from(msg.body, "base64").toString());
      const messages = incoming.messages || [];
      const lastMessage = messages[messages.length - 1];
      const text = lastMessage?.content || "";
      const userId = incoming.user || username || "browser-user";

      if (!text.trim()) {
        safeSend({ type: "response", requestId: msg.requestId, statusCode: 400,
          headers: { "content-type": "text/plain" },
          body: Buffer.from("Empty message").toString("base64") });
        return;
      }

      const agentId = resolveDefaultAgentId();

      const sessionKey = channelRuntime.routing.buildAgentSessionKey({
        agentId,
        channel: CHANNEL_ID,
        peer: { id: userId, type: "direct" },
        dmScope: currentCfg?.session?.dmScope || "per-channel-peer",
      });

      const storePath = channelRuntime.session.resolveStorePath(currentCfg?.session?.store, { agentId });

      const ctxPayload = {
        SessionKey: sessionKey,
        Body: text,
        BodyForAgent: text,
        From: `${CHANNEL_ID}:${userId}`,
        CommandAuthorized: true,
      };

      await channelRuntime.session.recordInboundSession({
        storePath,
        sessionKey,
        ctx: ctxPayload,
        onRecordError: (err) => {
          log.warn(`[cloud-relay] session record error: ${err.message}`);
        },
      });

      // Stream response back using SSE format (compatible with existing relay protocol)
      safeSend({ type: "response-start", requestId: msg.requestId,
        statusCode: 200,
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache", "connection": "keep-alive" } });

      let lastText = "";
      let hadError = false;

      await channelRuntime.reply.dispatchReplyWithBufferedBlockDispatcher({
        ctx: ctxPayload,
        cfg: currentCfg,
        dispatcherOptions: {
          deliver: async (block) => {
            lastText = block.text || lastText;
            const sseChunk = `data: ${JSON.stringify({
              id: `chatcmpl-${randomUUID()}`,
              object: "chat.completion.chunk",
              choices: [{ index: 0, delta: { content: block.text || "" }, finish_reason: null }],
            })}\n\n`;
            safeSend({ type: "response-chunk", requestId: msg.requestId, data: Buffer.from(sseChunk).toString("base64") });
            return { ok: true };
          },
          onError: (err) => {
            hadError = true;
            log.warn(`[cloud-relay] AI dispatch error: ${err?.message}`);
            const errChunk = `data: ${JSON.stringify({
              error: { message: err?.message || "Unknown error", type: "server_error" },
            })}\n\n`;
            safeSend({ type: "response-chunk", requestId: msg.requestId, data: Buffer.from(errChunk).toString("base64") });
          },
        },
      });

      if (!hadError) {
        const doneChunk = `data: ${JSON.stringify({
          id: `chatcmpl-${randomUUID()}`,
          object: "chat.completion.chunk",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        })}\n\ndata: [DONE]\n\n`;
        safeSend({ type: "response-chunk", requestId: msg.requestId, data: Buffer.from(doneChunk).toString("base64") });
      }

      safeSend({ type: "response-end", requestId: msg.requestId });
      log.info(`[cloud-relay] ${msg.method} ${msg.path} 200 (SDK dispatch) user=${userId}`);
    }

    // ============================================================
    // Register ChannelPlugin
    // ============================================================

    if (typeof api.registerChannel !== "function") {
      log.warn("[cloud-relay] api.registerChannel not available, starting relay directly (legacy mode)");
      connect();
      watchConfigForTokenChange();
    } else {

    api.registerChannel({
      id: CHANNEL_ID,

      meta: {
        id: CHANNEL_ID,
        label: "Cloud Relay",
        selectionLabel: "Cloud Relay (Browser)",
        blurb: "Browser chat sessions via Cloud Relay tunnel",
        order: 90,
        markdownCapable: true,
        exposure: { configured: true, setup: false, docs: false },
      },

      capabilities: {
        chatTypes: ["direct"],
        media: false,
        reactions: false,
        edit: false,
        unsend: false,
        reply: false,
        threads: false,
        polls: false,
        nativeCommands: false,
      },

      config: {
        listAccountIds: () => {
          return resolveToken() ? [DEFAULT_ACCOUNT_ID] : [];
        },
        resolveAccount: (cfg, accountId) => {
          return {
            accountId: accountId || DEFAULT_ACCOUNT_ID,
            enabled: Boolean(resolveToken()),
            relayUrl: resolveRelayUrl(),
          };
        },
        isEnabled: (account) => Boolean(account?.enabled || resolveToken()),
        isConfigured: (account) => Boolean(account?.relayUrl || resolveToken()),
      },

      gateway: {
        startAccount: async (ctx) => {
          log.info("[cloud-relay] channel startAccount");

          stopped = false;
          channelRuntime = ctx.channelRuntime || null;
          currentCfg = ctx.cfg;

          if (!channelRuntime) {
            log.warn("[cloud-relay] channelRuntime not available, SDK dispatch will not work");
          } else {
            log.info("[cloud-relay] channelRuntime available, using SDK dispatch for chat");
          }

          connect();
          watchConfigForTokenChange();

          return new Promise((resolve) => {
            if (ctx.abortSignal) {
              ctx.abortSignal.addEventListener("abort", () => {
                stopped = true;
                if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
                if (tokenPollTimer) { clearInterval(tokenPollTimer); tokenPollTimer = null; }
                stopHeartbeat();
                if (ws) { ws.close(1000, "shutdown"); ws = null; }
                resolve();
              });
            }
          });
        },

        stopAccount: async () => {
          log.info("[cloud-relay] channel stopAccount");
          stopped = true;
          if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
          if (tokenPollTimer) { clearInterval(tokenPollTimer); tokenPollTimer = null; }
          stopHeartbeat();
          if (ws) { ws.close(1000, "shutdown"); ws = null; }
          channelRuntime = null;
          currentCfg = null;
        },
      },

      outbound: {
        deliveryMode: "direct",
        textChunkLimit: 4000,

        sendText: async ({ to, text }) => {
          const userId = to.replace(`${CHANNEL_ID}:`, "");
          safeSend({
            type: "gateway.event",
            event: "chat.message",
            payload: { text },
            userId,
          });
          return { ok: true };
        },
      },
    });

    } // end registerChannel block

    // ============================================================
    // Graceful Shutdown
    // ============================================================

    process.on("SIGTERM", () => {
      stopped = true;
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      if (tokenPollTimer) { clearInterval(tokenPollTimer); tokenPollTimer = null; }
      stopHeartbeat();
      if (ws) { ws.close(1000, "shutdown"); ws = null; }
    });
  },
};
