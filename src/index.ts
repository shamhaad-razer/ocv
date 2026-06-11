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

    // Append server-supplied reply guidance to the system prompt for
    // cloud-relay turns. before_prompt_build is a GLOBAL hook - it fires for
    // every channel - so we scope it to this surface by channel id and no-op
    // for Telegram/Discord/etc. The guidance text comes entirely from the
    // server (openclaw.systemGuidance, surfaced via getCurrentReplyGuidance);
    // when the server doesn't send any, the plugin injects nothing and leaves
    // the system prompt untouched. Injecting via appendSystemContext keeps it
    // out of the persisted user message and lets prompt-caching amortize cost.
    if (typeof api.on === "function") {
      api.on("before_prompt_build", (_event, ctx) => {
        const channel = ctx.messageProvider || ctx.channelId;
        if (channel !== CHANNEL_ID) return undefined;
        const guidance = getCurrentReplyGuidance();
        if (!guidance) return undefined;
        console.log(
          `[cloud-relay] before_prompt_build: injecting server reply guidance into system prompt `
          + `(channel=${channel}, sessionKey=${ctx.sessionKey ?? "?"}, ${guidance.length} chars)`,
        );
        return { appendSystemContext: guidance };
      });
    } else {
      // Host doesn't expose typed hook registration - server-supplied reply
      // guidance can't be injected, so the agent may go silent (NO_REPLY) in
      // the app. Surfaced as a warning because it's a real capability gap, not
      // a per-turn event.
      console.warn(
        "[cloud-relay] api.on unavailable - before_prompt_build hook not registered; "
        + "server reply guidance will not be injected",
      );
    }
  },
};
