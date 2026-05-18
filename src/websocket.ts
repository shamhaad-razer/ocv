import { randomUUID } from "node:crypto";
import { HEARTBEAT_INTERVAL_MS, RECONNECT_DELAYS } from "./constants.js";
import type { Log, RelayState } from "./types.js";

export function safeSend(ws: WebSocket | null, msg: unknown, log: Log): void {
  try {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  } catch (err) {
    log.warn(`[cloud-relay] safeSend failed: ${(err as Error).message}`);
  }
}

export function sendSseText(ws: WebSocket | null, requestId: unknown, text: string, log: Log): void {
  if (!text) return;
  const sseChunk = `data: ${JSON.stringify({
    id: `chatcmpl-${randomUUID()}`,
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
  })}\n\n`;
  safeSend(ws, { type: "response-chunk", requestId, data: Buffer.from(sseChunk).toString("base64") }, log);
}

export function startHeartbeat(state: RelayState, log: Log): void {
  if (state.heartbeatTimer) {
    clearInterval(state.heartbeatTimer);
    state.heartbeatTimer = null;
  }
  state.heartbeatTimer = setInterval(
    () => safeSend(state.ws, { type: "ping", ts: Date.now() }, log),
    HEARTBEAT_INTERVAL_MS,
  );
}

export function scheduleReconnect(state: RelayState, connect: () => void, log: Log): void {
  if (state.stopped || state.reconnectTimer) return;
  const delay = RECONNECT_DELAYS[Math.min(state.reconnectAttempt, RECONNECT_DELAYS.length - 1)]!;
  state.reconnectAttempt++;
  log.info(`[cloud-relay] Reconnecting in ${delay / 1000}s (attempt ${state.reconnectAttempt})...`);
  state.reconnectTimer = setTimeout(() => {
    state.reconnectTimer = null;
    connect();
  }, delay);
}

export function teardown(state: RelayState): void {
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
    state.ws.close(1000, "shutdown");
    state.ws = null;
  }
}
