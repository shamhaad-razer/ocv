import type { ActiveRequest, ChannelRuntime, RelayState } from "./types.js";

let pluginRuntime: { channel?: ChannelRuntime } | null = null;
let gatewayChannelRuntime: ChannelRuntime | null = null;
let activeRequest: ActiveRequest | null = null;
let relayState: RelayState | null = null;
const lastSessionKeyByUser = new Map<string, string>();
// Reply guidance for the in-flight cloud-relay turn, supplied per-request by
// the browser (openclaw.guidanceForLLM). Read by the before_prompt_build hook.
// Safe as a single module-level value because dispatch is serialized through
// runInDispatchQueue — only one cloud-relay turn is ever in flight at a time.
let currentReplyGuidance: string | null = null;

export function getPluginRuntime() { return pluginRuntime; }
export function setPluginRuntime(rt: { channel?: ChannelRuntime } | null) { pluginRuntime = rt; }

export function getGatewayChannelRuntime() { return gatewayChannelRuntime; }
export function setGatewayChannelRuntime(rt: ChannelRuntime | null) { gatewayChannelRuntime = rt; }

export function getActiveRequest() { return activeRequest; }
export function setActiveRequest(req: ActiveRequest | null) { activeRequest = req; }

export function getRelayState() { return relayState; }
export function setRelayState(state: RelayState | null) { relayState = state; }

export function getCurrentReplyGuidance() { return currentReplyGuidance; }
export function setCurrentReplyGuidance(guidance: string | null) { currentReplyGuidance = guidance; }

export function rememberSessionKey(userId: string, sessionKey: string) {
  if (userId && sessionKey) lastSessionKeyByUser.set(userId, sessionKey);
}
export function getLastSessionKey(userId: string): string | undefined {
  return lastSessionKeyByUser.get(userId);
}

export function resolveChannelRuntime(ctx?: { channelRuntime?: ChannelRuntime }): ChannelRuntime | null {
  return gatewayChannelRuntime || pluginRuntime?.channel || ctx?.channelRuntime || null;
}
