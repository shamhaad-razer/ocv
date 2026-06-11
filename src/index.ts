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
      const guidanceForLLM = getCurrentReplyGuidance() || "";
      if (!guidanceForLLM) {
        console.log(
          `[cloud-relay] before_prompt_build: no guidance supplied for this turn `
          + `(channel=${channel}, sessionKey=${ctx.sessionKey ?? "?"}) — system prompt unchanged`,
        );
        return undefined;
      }
      const containsVoice = guidanceForLLM.includes("currently in voice mode");
      const containsText = guidanceForLLM.includes("currently in text mode");
      console.log(
        `[cloud-relay] before_prompt_build: injecting reply guidance into system prompt `
        + `(channel=${channel}, sessionKey=${ctx.sessionKey ?? "?"}, ${guidanceForLLM.length} chars, `
        + `voiceSuffix=${containsVoice}, textSuffix=${containsText})`,
      );
      // [TEMP DIAG] full string so we can verify exact wording reaches the host
      console.log(`[cloud-relay-diag] guidance returned: ${JSON.stringify(guidanceForLLM)}`);
      return { appendSystemContext: guidanceForLLM };
    });
    console.log("[cloud-relay] registered before_prompt_build hook for reply guidance");

    // [TEMP DIAG] Verify what actually reaches the LLM. Tail the gateway
    // log for `[cloud-relay-diag] llm_input` to see the assembled system
    // prompt and confirm the modality suffix is present. Remove once the
    // mode-aware feature is confirmed working.
    api.on?.("llm_input", (event, ctx) => {
      const channel = ctx.messageProvider || ctx.channelId;
      if (channel !== CHANNEL_ID) return;
      const sys = event.systemPrompt ?? "";
      const lastUser = event.prompt ?? "";
      const sysTail = sys.length > 800 ? "..." + sys.slice(-800) : sys;
      const containsVoice = sys.includes("currently in voice mode");
      const containsText = sys.includes("currently in text mode");
      console.log(
        `[cloud-relay-diag] llm_input runId=${event.runId} model=${event.model} `
        + `systemPromptLen=${sys.length} containsVoiceSuffix=${containsVoice} containsTextSuffix=${containsText} `
        + `userPrompt=${JSON.stringify(lastUser).slice(0, 120)}`,
      );
      console.log(`[cloud-relay-diag] systemPrompt tail (last ~800 chars): ${JSON.stringify(sysTail)}`);
    });
  },
};
