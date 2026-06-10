export const DEFAULT_RELAY_URL = "https://ocv.razer.ai";
export const RECONNECT_DELAYS = [1000, 2000, 4000, 8000, 16000, 30000];
export const POLL_TIMEOUT_MS = 35_000;
export const CHANNEL_ID = "cloud-relay";
export const DEFAULT_ACCOUNT_ID = "default";
export const DEFAULT_AGENT_ID = "main";
export const TOKEN_POLL_INTERVAL_MS = 5000;
export const MAX_OUTBOUND_MEDIA_BYTES = 15 * 1024 * 1024;

// Appended to the agent's system prompt for cloud-relay turns only (via the
// `before_prompt_build` hook). The browser app is interactive — the user is
// staring at the screen (and in voice mode, listening) waiting for a reply —
// so the agent must never go silent. By default OpenClaw tells the model to
// emit NO_REPLY when it has nothing to say; that produces an empty bubble /
// dead air here, which reads as broken. This guidance overrides that for the
// relay surface without touching the prompt on other channels (Telegram, etc.)
// where staying silent is fine. It's injected as system context (not into the
// user message) so it never pollutes the persisted chat history, and as a
// static string so provider prompt-caching keeps it ~free per turn.
export const RELAY_REPLY_GUIDANCE =
  "You are replying inside an interactive app where the user is waiting for a "
  + "response (often a live voice call, read aloud). Always reply with a short, "
  + 'natural line — even to brief messages like "okay", "thanks", or "stop". '
  + "Never stay silent or respond with NO_REPLY.";
