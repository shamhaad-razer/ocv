export interface RelayState {
  stopped: boolean;
  reconnectAttempt: number;
  pollAbort: AbortController | null;
  tokenPollTimer: ReturnType<typeof setInterval> | null;
  lastKnownToken: string;
  username: string | null;
  relayHttpUrl: string;
  token: string;
}

export interface StreamDeliveryState {
  sentFinal: boolean;
}

export interface RespondContext {
  runId: string;
  sessionKey: string;
  userId: string;
}

export interface ActiveRequest {
  relayState: RelayState;
  log: Log;
  streamState: StreamDeliveryState;
  respondCtx: RespondContext;
}

export interface ResolvedAccount {
  accountId: string;
  enabled: boolean;
  configured: boolean;
  token: string;
  relayUrl: string;
}

export interface ChannelRuntime {
  routing: {
    buildAgentSessionKey: (params: Record<string, unknown>) => string;
  };
  session: {
    resolveStorePath: (store: string | undefined, opts: { agentId: string }) => string;
    recordInboundSession: (params: Record<string, unknown>) => Promise<void>;
  };
  reply: {
    dispatchReplyWithBufferedBlockDispatcher: (params: Record<string, unknown>) => Promise<void>;
  };
}

export interface GatewayContext {
  cfg: Record<string, unknown>;
  accountId?: string;
  account?: ResolvedAccount;
  channelRuntime?: ChannelRuntime;
  abortSignal?: AbortSignal;
  log?: Log;
}

export interface Log {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

// Subset of the OpenClaw `before_prompt_build` hook surface we use. The full
// types live in the openclaw package (hook-types.d.ts); we mirror only what
// this plugin reads/returns to avoid a hard dependency on the host's types.
export interface BeforePromptBuildEvent {
  prompt: string;
  messages: unknown[];
}

export interface BeforePromptBuildContext {
  // Originating channel for this turn — "cloud-relay" for our surface,
  // "telegram"/"discord"/… for others. Used to scope prompt injection to
  // relay turns only.
  messageProvider?: string;
  channelId?: string;
  sessionKey?: string;
}

export interface BeforePromptBuildResult {
  // Appended to the system prompt (cacheable, not persisted to user history).
  appendSystemContext?: string;
}

// Diagnostic-only: shape of the host's `llm_input` event so the plugin
// can verify the assembled system prompt actually contains the
// before_prompt_build appendSystemContext we returned.
export interface LlmInputEvent {
  runId: string;
  sessionId: string;
  provider: string;
  model: string;
  systemPrompt?: string;
  prompt: string;
  historyMessages: unknown[];
  imagesCount: number;
  tools?: unknown[];
}

export interface PluginApi {
  runtime?: { channel?: ChannelRuntime };
  registerChannel: (opts: { plugin: unknown }) => void;
  // Typed hook registration. Optional because older hosts may not expose it.
  on?: {
    (
      hookName: "before_prompt_build",
      handler: (
        event: BeforePromptBuildEvent,
        ctx: BeforePromptBuildContext,
      ) => BeforePromptBuildResult | undefined | Promise<BeforePromptBuildResult | undefined>,
      opts?: { priority?: number; timeoutMs?: number },
    ): void;
    (
      hookName: "llm_input",
      handler: (
        event: LlmInputEvent,
        ctx: BeforePromptBuildContext,
      ) => void | Promise<void>,
      opts?: { priority?: number; timeoutMs?: number },
    ): void;
  };
}

export type OutboundMediaContext = {
  to: string;
  text?: string;
  mediaUrl?: string;
  audioAsVoice?: boolean;
  mediaReadFile?: (filePath: string) => Promise<Buffer>;
  mediaAccess?: {
    readFile?: (filePath: string) => Promise<Buffer>;
    workspaceDir?: string;
  };
};
