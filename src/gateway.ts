import { POLL_TIMEOUT_MS, RECONNECT_DELAYS, TOKEN_POLL_INTERVAL_MS } from "./constants.js";
import { resolveAccount, resolveRelayUrl, resolveToken } from "./config.js";
import { dispatchChat } from "./dispatch.js";
import { resolveChannelRuntime, setGatewayChannelRuntime, setRelayState } from "./state.js";
import type { GatewayContext, Log, RelayState } from "./types.js";

function deriveHttpUrl(wsUrl: string): string {
  return wsUrl
    .replace(/\/_tunnel$/, "")
    .replace(/^wss:/, "https:")
    .replace(/^ws:/, "http:");
}

export async function startGatewayAccount(ctx: GatewayContext): Promise<void> {
  const log: Log = ctx.log || { info: console.log, warn: console.warn, error: console.error };
  const account = ctx.account || resolveAccount(ctx.cfg, ctx.accountId);

  if (!account.token) {
    log.error("[cloud-relay] No token configured.");
    throw new Error("Cloud Relay token not configured");
  }

  setGatewayChannelRuntime(ctx.channelRuntime || null);

  const relayHttpUrl = deriveHttpUrl(resolveRelayUrl(ctx.cfg));
  const state: RelayState = {
    stopped: false,
    reconnectAttempt: 0,
    pollAbort: null,
    tokenPollTimer: null,
    lastKnownToken: account.token,
    username: null,
    relayHttpUrl,
    token: account.token,
  };

  setRelayState(state);

  log.info(`[cloud-relay] Starting long-poll gateway: ${relayHttpUrl}`);

  // Token change watcher
  state.tokenPollTimer = setInterval(() => {
    try {
      const newToken = resolveToken(ctx.cfg);
      if (newToken && newToken !== state.lastKnownToken) {
        state.lastKnownToken = newToken;
        state.token = newToken;
        log.info("[cloud-relay] Token changed, next poll will use new token");
        // Abort current poll so it retries with new token immediately
        state.pollAbort?.abort();
      }
    } catch (err) {
      log.warn(`[cloud-relay] Token poll error: ${(err as Error).message}`);
    }
  }, TOKEN_POLL_INTERVAL_MS);

  // Poll loop
  const pollLoop = async () => {
    while (!state.stopped) {
      const abort = new AbortController();
      state.pollAbort = abort;

      try {
        const pollUrl = state.username
          ? `${state.relayHttpUrl}/api/poll?username=${encodeURIComponent(state.username)}`
          : `${state.relayHttpUrl}/api/poll`;
        const resp = await fetch(pollUrl, {
          headers: { "Authorization": `Bearer ${state.token}` },
          signal: abort.signal,
        });

        if (state.stopped) break;

        if (resp.status === 204) {
          // Timeout, no messages — poll again
          state.reconnectAttempt = 0;
          if (!state.username) {
            const hdr = resp.headers.get("x-username");
            if (hdr) {
              state.username = hdr;
              log.info(`[cloud-relay] Registered as ${state.username}`);
            }
          }
          continue;
        }

        if (resp.status === 401) {
          log.error("[cloud-relay] Poll auth failed (401). Check token.");
          state.stopped = true;
          break;
        }

        if (resp.ok) {
          state.reconnectAttempt = 0;
          const msg = await resp.json() as Record<string, unknown>;
          if (!state.username && msg.username) {
            state.username = msg.username as string;
            log.info(`[cloud-relay] Registered as ${state.username}`);
          }
          // Dispatch the request
          const channelRuntime = resolveChannelRuntime(ctx);
          if (channelRuntime) {
            dispatchChat(msg, state, ctx, log, channelRuntime).catch((err) => {
              log.error(`[cloud-relay] dispatch error: ${(err as Error).message}`);
            });
          } else {
            log.warn("[cloud-relay] channelRuntime not available, dropping message");
          }
          continue;
        }

        // Other error
        log.warn(`[cloud-relay] Poll unexpected status: ${resp.status}`);
      } catch (err) {
        if ((err as Error).name === "AbortError") {
          if (state.stopped) break;
          continue; // Token change triggered abort, retry immediately
        }
        // Network error — backoff
        const delay = RECONNECT_DELAYS[Math.min(state.reconnectAttempt, RECONNECT_DELAYS.length - 1)]!;
        state.reconnectAttempt++;
        log.warn(`[cloud-relay] Poll error: ${(err as Error).message}, retry in ${delay / 1000}s`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }

    log.info("[cloud-relay] Poll loop stopped");
  };

  // Start polling in background
  const pollPromise = pollLoop();

  // Wait until abort signal or poll loop exits
  return new Promise<void>((resolve) => {
    if (ctx.abortSignal) {
      ctx.abortSignal.addEventListener("abort", () => {
        state.stopped = true;
        state.pollAbort?.abort();
        if (state.tokenPollTimer) {
          clearInterval(state.tokenPollTimer);
          state.tokenPollTimer = null;
        }
        setRelayState(null);
        pollPromise.then(resolve);
      });
    }
    // If no abort signal, the promise stays pending (gateway keeps running)
  });
}
