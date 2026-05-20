import type { ChannelRuntime, Log } from "./types.js";

let pluginRuntime: { channel?: ChannelRuntime } | null = null;
let gatewayChannelRuntime: ChannelRuntime | null = null;
let activeRequest: { requestId: unknown; ws: WebSocket | null; log: Log } | null = null;
let lastSentText = "";

export function getPluginRuntime() { return pluginRuntime; }
export function setPluginRuntime(rt: { channel?: ChannelRuntime } | null) { pluginRuntime = rt; }

export function getGatewayChannelRuntime() { return gatewayChannelRuntime; }
export function setGatewayChannelRuntime(rt: ChannelRuntime | null) { gatewayChannelRuntime = rt; }

export function getActiveRequest() { return activeRequest; }
export function setActiveRequest(req: { requestId: unknown; ws: WebSocket | null; log: Log } | null) {
  activeRequest = req;
  lastSentText = "";
}

export function getLastSentText() { return lastSentText; }
export function setLastSentText(text: string) { lastSentText = text; }

export function resolveChannelRuntime(ctx?: { channelRuntime?: ChannelRuntime }): ChannelRuntime | null {
  return gatewayChannelRuntime || pluginRuntime?.channel || ctx?.channelRuntime || null;
}
