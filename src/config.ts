import { DEFAULT_ACCOUNT_ID, DEFAULT_AGENT_ID, DEFAULT_RELAY_URL } from "./constants.js";
import type { ResolvedAccount } from "./types.js";

export function resolveChannelConfig(cfg: Record<string, unknown>): Record<string, unknown> {
  const channels = cfg?.channels as Record<string, unknown> | undefined;
  const channelSection = channels?.["cloud-relay"] as Record<string, unknown> | undefined;
  const plugins = cfg?.plugins as Record<string, unknown> | undefined;
  const entries = plugins?.entries as Record<string, { config?: Record<string, unknown> }> | undefined;
  const pluginSection = entries?.["cloud-relay"]?.config;
  return channelSection || pluginSection || {};
}

export function resolveToken(cfg: Record<string, unknown>): string {
  return (resolveChannelConfig(cfg)?.token as string) || process.env.CLOUD_RELAY_TOKEN || "";
}

export function resolveRelayUrl(cfg: Record<string, unknown>): string {
  return (resolveChannelConfig(cfg)?.relayUrl as string) || DEFAULT_RELAY_URL;
}

export function normalizeAgentId(value: string | undefined | null): string {
  const normalized = (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+/g, "")
    .replace(/-+$/g, "");
  return normalized || DEFAULT_AGENT_ID;
}

export function resolveDefaultAgentId(cfg: Record<string, unknown>): string {
  const agentsCfg = cfg?.agents as { list?: Array<{ id?: string; default?: boolean }> } | undefined;
  const agents = Array.isArray(agentsCfg?.list) ? agentsCfg!.list : [];
  const chosen = (agents.find((agent) => agent?.default) ?? agents[0])?.id;
  return normalizeAgentId(chosen);
}

export function resolveAccount(cfg: Record<string, unknown>, accountId?: string | null): ResolvedAccount {
  const token = resolveToken(cfg);
  const relayUrl = resolveRelayUrl(cfg);
  return {
    accountId: accountId || DEFAULT_ACCOUNT_ID,
    enabled: Boolean(token),
    configured: Boolean(token),
    token,
    relayUrl,
  };
}
