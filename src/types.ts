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
  hadPartial: boolean;
  sentFinal: boolean;
}

export interface ActiveRequest {
  requestId: string;
  relayState: RelayState;
  log: Log;
  streamState: StreamDeliveryState;
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
