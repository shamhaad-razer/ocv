import type { ActiveRequest, ChannelRuntime, RelayState } from "./types.js";

let pluginRuntime: { channel?: ChannelRuntime } | null = null;
let gatewayChannelRuntime: ChannelRuntime | null = null;
let activeRequest: ActiveRequest | null = null;
let relayState: RelayState | null = null;

export function getPluginRuntime() { return pluginRuntime; }
export function setPluginRuntime(rt: { channel?: ChannelRuntime } | null) { pluginRuntime = rt; }

export function getGatewayChannelRuntime() { return gatewayChannelRuntime; }
export function setGatewayChannelRuntime(rt: ChannelRuntime | null) { gatewayChannelRuntime = rt; }

export function getActiveRequest() { return activeRequest; }
export function setActiveRequest(req: ActiveRequest | null) { activeRequest = req; }

export function getRelayState() { return relayState; }
export function setRelayState(state: RelayState | null) { relayState = state; }

export function resolveChannelRuntime(ctx?: { channelRuntime?: ChannelRuntime }): ChannelRuntime | null {
  return gatewayChannelRuntime || pluginRuntime?.channel || ctx?.channelRuntime || null;
}
