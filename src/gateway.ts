import { CHANNEL_ID, TOKEN_POLL_INTERVAL_MS } from "./constants.js";
import { resolveAccount, resolveRelayUrl, resolveToken } from "./config.js";
import { dispatchChat } from "./dispatch.js";
import { resolveChannelRuntime, setGatewayChannelRuntime } from "./state.js";
import { safeSend, scheduleReconnect, startHeartbeat, teardown } from "./websocket.js";
import type { GatewayContext, Log, RelayState } from "./types.js";

export async function startGatewayAccount(ctx: GatewayContext): Promise<void> {
  const log: Log = ctx.log || { info: console.log, warn: console.warn, error: console.error };
  const account = ctx.account || resolveAccount(ctx.cfg, ctx.accountId);

  log.info("[cloud-relay] channel startAccount");

  if (!account.token) {
    log.error("[cloud-relay] No token configured.");
    log.error("[cloud-relay] 1. Sign in at https://ocv.razer.ai and copy your token");
    log.error('[cloud-relay] 2. Add it to ~/.openclaw/openclaw.json:');
    log.error('[cloud-relay]    channels.cloud-relay.token = "your-token"');
    throw new Error("Cloud Relay token not configured");
  }

  setGatewayChannelRuntime(ctx.channelRuntime || null);
  if (ctx.channelRuntime) {
    log.info("[cloud-relay] ctx.channelRuntime available, using SDK dispatch for chat");
  } else {
    log.warn("[cloud-relay] channelRuntime not available, SDK dispatch will not work");
  }

  const state: RelayState = {
    ws: null,
    connecting: false,
    stopped: false,
    reconnectAttempt: 0,
    reconnectTimer: null,
    heartbeatTimer: null,
    tokenPollTimer: null,
    lastKnownToken: account.token,
    username: null,
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

    let thisWs: WebSocket;
    try {
      thisWs = new WebSocket(`${relayUrl}?token=${token}`);
    } catch (err) {
      state.connecting = false;
      log.error(`[cloud-relay] Connection failed: ${(err as Error).message}`);
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

    thisWs.addEventListener("message", (event: MessageEvent) => {
      if (state.ws !== thisWs) return;
      let parsedMsg: Record<string, unknown>;
      try {
        parsedMsg = JSON.parse(typeof event.data === "string" ? event.data : String(event.data));
      } catch { return; }

      if (parsedMsg.type === "error") { log.error(`[cloud-relay] Server error: ${parsedMsg.message}`); return; }
      if (parsedMsg.type === "pong") return;

      if (parsedMsg.type === "registered") {
        state.username = parsedMsg.username as string;
        const host = relayUrl.replace("ws://", "").replace("wss://", "").replace("/_tunnel", "");
        log.info("[cloud-relay] Tunnel established!");
        log.info(`[cloud-relay]   User:     ${state.username}`);
        log.info(`[cloud-relay]   Chat URL: https://${host}/`);
        return;
      }

      if (parsedMsg.type === "request") {
        const channelRuntime = resolveChannelRuntime(ctx);
        if (!channelRuntime) {
          safeSend(state.ws, {
            type: "response", requestId: parsedMsg.requestId, statusCode: 503,
            headers: { "content-type": "text/plain" },
            body: Buffer.from("Channel not ready").toString("base64"),
          }, log);
          return;
        }
        dispatchChat(parsedMsg, state, ctx, log, channelRuntime).catch((err) => {
          log.error(`[cloud-relay] dispatch error: ${(err as Error).message}`);
          safeSend(state.ws, {
            type: "response", requestId: parsedMsg.requestId, statusCode: 502,
            headers: { "content-type": "text/plain" },
            body: Buffer.from(`Dispatch failed - ${(err as Error).message}`).toString("base64"),
          }, log);
        });
      }
    });

    thisWs.addEventListener("close", (event: CloseEvent) => {
      if (state.ws !== thisWs) return;
      log.info(`[cloud-relay] Disconnected: ${event.code} ${event.reason || ""}`);
      state.ws = null;
      state.connecting = false;
      if (state.heartbeatTimer) { clearInterval(state.heartbeatTimer); state.heartbeatTimer = null; }
      if (event.code === 4000 || event.code === 4001 || event.code === 4003) {
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
          if (state.ws) { state.ws.close(1000, "token changed"); state.ws = null; }
          state.connecting = false;
          if (state.heartbeatTimer) { clearInterval(state.heartbeatTimer); state.heartbeatTimer = null; }
          if (state.reconnectTimer) { clearTimeout(state.reconnectTimer); state.reconnectTimer = null; }
          state.reconnectAttempt = 0;
          connect();
        }
      } catch (err) {
        log.warn(`[cloud-relay] Token poll error: ${(err as Error).message}`);
      }
    }, TOKEN_POLL_INTERVAL_MS);
  }

  log.info(`[cloud-relay] Starting gateway for account "${account.accountId}"`);
  connect();
  watchConfigForTokenChange();

  return new Promise<void>((resolve) => {
    if (ctx.abortSignal) {
      ctx.abortSignal.addEventListener("abort", () => {
        teardown(state);
        resolve();
      });
    }
  });
}
