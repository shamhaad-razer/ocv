import { CHANNEL_ID, DEFAULT_ACCOUNT_ID } from "./constants.js";
import { resolveAccount } from "./config.js";
import { startGatewayAccount } from "./gateway.js";
import { outboundAdapter } from "./outbound.js";
import type { GatewayContext, Log, ResolvedAccount } from "./types.js";

export const cloudRelayPlugin = {
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
    media: true,
    reactions: false,
    edit: false,
    unsend: false,
    reply: false,
    threads: false,
    polls: false,
    nativeCommands: false,
  },

  config: {
    listAccountIds: () => [DEFAULT_ACCOUNT_ID],
    resolveAccount: (cfg: Record<string, unknown>, accountId?: string | null) =>
      resolveAccount(cfg, accountId),
    isEnabled: (account: ResolvedAccount) => Boolean(account?.enabled),
    isConfigured: (account: ResolvedAccount) => Boolean(account?.configured),
  },

  gateway: {
    startAccount: async (ctx: GatewayContext) => startGatewayAccount(ctx),
    stopAccount: async (ctx: GatewayContext) => {
      const log: Log = ctx?.log || { info: console.log, warn: console.warn, error: console.error };
      log.info("[cloud-relay] channel stopAccount");
    },
  },

  outbound: outboundAdapter,
};
