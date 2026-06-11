import { CHANNEL_ID } from "./constants.js";
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

    // Append per-turn guidance from the browser to the system prompt for
    // cloud-relay turns. The frontend builds the full string
    // (RELAY_REPLY_GUIDANCE + voice/text mode suffix) and ships it under
    // openclaw.guidanceForLLM; we only forward it here.
    // before_prompt_build is a GLOBAL hook - it fires for every channel - so we
    // scope it to this surface by channel id and no-op for Telegram/Discord/etc.
    // Injecting via appendSystemContext keeps it out of the persisted user
    // message and lets provider prompt-caching amortize the token cost.
    api.on?.("before_prompt_build", (_event, ctx) => {
      const channel = ctx.messageProvider || ctx.channelId;
      if (channel !== CHANNEL_ID) {
        console.log(
          `[cloud-relay] before_prompt_build: skip (channel=${channel ?? "?"}, not ${CHANNEL_ID}) - system prompt unchanged`,
        );
        return undefined;
      }
      const guidanceForLLM = getCurrentReplyGuidance() || "";
      if (!guidanceForLLM) {
        console.log(
          `[cloud-relay] before_prompt_build: no guidance supplied for this turn `
          + `(channel=${channel}, sessionKey=${ctx.sessionKey ?? "?"}) - system prompt unchanged`,
        );
        return undefined;
      }
      console.log(
        `[cloud-relay] before_prompt_build: injecting reply guidance into system prompt `
        + `(channel=${channel}, sessionKey=${ctx.sessionKey ?? "?"}, ${guidanceForLLM.length} chars)`,
      );
      return { appendSystemContext: guidanceForLLM };
    });
    console.log("[cloud-relay] registered before_prompt_build hook for reply guidance");
  },
};
