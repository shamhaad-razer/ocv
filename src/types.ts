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

export interface PluginApi {
  runtime?: { channel?: ChannelRuntime };
  registerChannel: (opts: { plugin: unknown }) => void;
  registerTool?: (tool: BrowserTool, opts?: { optional?: boolean }) => void;
}

export interface ToolResultContent {
  type: "text";
  text: string;
}

export interface AgentToolResult {
  content: ToolResultContent[];
  isError?: boolean;
}

// Subset of openclaw's ToolDefinition this plugin uses. `execute` mirrors
// openclaw's (toolCallId, params, signal, …) contract.
export interface BrowserTool {
  name: string;
  label: string;
  description: string;
  promptSnippet?: string;
  parameters: unknown;
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<AgentToolResult>;
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
