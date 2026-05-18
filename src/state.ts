import type { ChannelRuntime, Log } from "./types.js";

let pluginRuntime: { channel?: ChannelRuntime } | null = null;
let gatewayChannelRuntime: ChannelRuntime | null = null;
let activeRequest: { requestId: unknown; ws: WebSocket | null; log: Log } | null = null;

export function getPluginRuntime() { return pluginRuntime; }
export function setPluginRuntime(rt: { channel?: ChannelRuntime } | null) { pluginRuntime = rt; }

export function getGatewayChannelRuntime() { return gatewayChannelRuntime; }
export function setGatewayChannelRuntime(rt: ChannelRuntime | null) { gatewayChannelRuntime = rt; }

export function getActiveRequest() { return activeRequest; }
export function setActiveRequest(req: { requestId: unknown; ws: WebSocket | null; log: Log } | null) { activeRequest = req; }

export function resolveChannelRuntime(ctx?: { channelRuntime?: ChannelRuntime }): ChannelRuntime | null {
  return gatewayChannelRuntime || pluginRuntime?.channel || ctx?.channelRuntime || null;
}
