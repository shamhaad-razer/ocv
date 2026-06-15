import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildReplyOptions } from "../reply-options.js";
import type { Log, RelayState } from "../types.js";

function makeState(): RelayState {
  return {
    stopped: false,
    reconnectAttempt: 0,
    pollAbort: null,
    tokenPollTimer: null,
    lastKnownToken: "tok",
    username: "RZR_alice",
    relayHttpUrl: "https://relay.test",
    token: "tok",
  };
}

function makeLog(): Log {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function respondPosts(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls
    .filter(([url]) => String(url).endsWith("/api/respond"))
    .map(([, init]) => JSON.parse((init as { body: string }).body));
}

describe("buildReplyOptions.onPartialReply", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn(async () => ({ ok: true, status: 200, statusText: "OK" }));
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  const respondCtx = { runId: "run-1", sessionKey: "py:RZR_alice:default", userId: "RZR_alice" };

  it("posts a chunk carrying the partial text + respond context", async () => {
    const streamState = { sentFinal: false };
    const opts = buildReplyOptions(makeLog(), { state: makeState(), respondCtx, streamState });
    await opts.onPartialReply({ text: "Hello", delta: "Hello" });

    const posts = respondPosts(fetchMock);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toEqual({ type: "chunk", text: "Hello", ...respondCtx });
  });

  it("does not post once sentFinal is set", async () => {
    const streamState = { sentFinal: true };
    const opts = buildReplyOptions(makeLog(), { state: makeState(), respondCtx, streamState });
    await opts.onPartialReply({ text: "late", delta: "late" });
    expect(respondPosts(fetchMock)).toHaveLength(0);
  });

  it("does not post when the partial has no text", async () => {
    const streamState = { sentFinal: false };
    const opts = buildReplyOptions(makeLog(), { state: makeState(), respondCtx, streamState });
    await opts.onPartialReply({ delta: "" });
    expect(respondPosts(fetchMock)).toHaveLength(0);
  });

  it("is a no-op when no partial context is supplied (e.g. health-only build)", async () => {
    const opts = buildReplyOptions(makeLog());
    await opts.onPartialReply({ text: "x" });
    expect(respondPosts(fetchMock)).toHaveLength(0);
  });
});
