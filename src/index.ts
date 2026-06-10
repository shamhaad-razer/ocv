import { CHANNEL_ID, RELAY_REPLY_GUIDANCE } from "./constants.js";
import { cloudRelayPlugin } from "./plugin.js";
import { getCurrentReplyGuidance, setPluginRuntime } from "./state.js";
import type { PluginApi } from "./types.js";

export default {
  id: CHANNEL_ID,
  name: "Cloud Relay Tunnel",
  description: "Browser chat sessions via Cloud Relay tunnel",
  register(api: PluginApi) {
    setPluginRuntime(api.runtime || null);
    api.registerChannel({ plugin: cloudRelayPlugin });

    // Append reply guidance to the system prompt for cloud-relay turns so the
    // agent never goes silent in the interactive app (see RELAY_REPLY_GUIDANCE).
    // before_prompt_build is a GLOBAL hook — it fires for every channel — so we
    // scope it to this surface by channel id and no-op for Telegram/Discord/etc.
    // Injecting via appendSystemContext keeps it out of the persisted user
    // message and lets provider prompt-caching amortize the token cost.
    api.on?.("before_prompt_build", (_event, ctx) => {
      const channel = ctx.messageProvider || ctx.channelId;
      if (channel !== CHANNEL_ID) {
        console.log(
          `[cloud-relay] before_prompt_build: skip (channel=${channel ?? "?"}, not ${CHANNEL_ID}) — system prompt unchanged`,
        );
        return undefined;
      }
      // Prefer the per-request guidance the server supplied for this turn
      // (openclaw.systemGuidance); fall back to the built-in default when it
      // didn't send one. Lets operators retune the wording from the server
      // without re-shipping the plugin.
      const guidance = getCurrentReplyGuidance() || RELAY_REPLY_GUIDANCE;
      const fromServer = Boolean(getCurrentReplyGuidance());
      console.log(
        `[cloud-relay] before_prompt_build: injecting reply guidance into system prompt `
        + `(channel=${channel}, sessionKey=${ctx.sessionKey ?? "?"}, ${guidance.length} chars, `
        + `source=${fromServer ? "server" : "default"})`,
      );
      return { appendSystemContext: guidance };
    });
    console.log("[cloud-relay] registered before_prompt_build hook for reply guidance");
  },
};
