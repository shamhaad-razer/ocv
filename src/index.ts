import { registerBrowserTools } from "./tools/index.js";
import { CHANNEL_ID } from "./constants.js";
import { cloudRelayPlugin } from "./plugin.js";
import { setPluginRuntime } from "./state.js";
import type { PluginApi } from "./types.js";

export default {
  id: CHANNEL_ID,
  name: "Cloud Relay Tunnel",
  description: "Browser chat sessions via Cloud Relay tunnel",
  register(api: PluginApi) {
    setPluginRuntime(api.runtime || null);
    api.registerChannel({ plugin: cloudRelayPlugin });
    registerBrowserTools(api);
  },
};
