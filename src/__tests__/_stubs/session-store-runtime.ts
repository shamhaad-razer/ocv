// Test stub for the host-provided `openclaw/plugin-sdk/session-store-runtime`
// module. At build time esbuild marks `openclaw` external (the real host
// supplies it); under Vitest there is no host, so vitest.config.ts aliases the
// specifier to this file. The defaults below make readHistory return [] (no
// session) unless a test overrides them via vi.mocked(...).

export function getSessionEntry(_params: { storePath: string; sessionKey: string }): { sessionId?: string } | undefined {
  return undefined;
}

export function resolveSessionTranscriptPathInDir(sessionId: string, dir: string): string {
  return `${dir}/${sessionId}.ndjson`;
}

export function resolveStorePath(store: string | undefined, opts: { agentId: string }): string {
  return store || `/tmp/openclaw-test/${opts.agentId}/store.json`;
}
