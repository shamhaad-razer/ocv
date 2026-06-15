import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dispatchRequest } from "../dispatch.js";
import { setActiveRequest, setCurrentReplyGuidance } from "../state.js";
import type { ChannelRuntime, GatewayContext, Log, RelayState } from "../types.js";

// dispatch.ts is the heart of what ocv exchanges with service-voice: it decodes
// the base64 /api/poll body, drives the reply runtime, and posts chunk/end/error
// to /api/respond. We drive it with a fake ChannelRuntime + fetch mock so no
// real openclaw host or network is involved.

function b64(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString("base64");
}

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

interface FakeRuntimeOptions {
  // What the reply runtime "produces". Each block is delivered via deliver().
  deliver?: string;
  // If set, the runtime invokes onError with this before/instead of delivering.
  error?: string;
  // If set, the runtime invokes onPartialReply with these chunk texts first.
  partials?: string[];
}

function makeChannelRuntime(opts: FakeRuntimeOptions = {}): ChannelRuntime {
  return {
    routing: {
      buildAgentSessionKey: () => "agent-session-key",
    },
    session: {
      resolveStorePath: () => "/tmp/store.json",
      recordInboundSession: vi.fn(async () => {}),
    },
    reply: {
      dispatchReplyWithBufferedBlockDispatcher: async (params: Record<string, unknown>) => {
        const dispatcherOptions = params.dispatcherOptions as {
          deliver: (block: { text?: string }) => Promise<{ ok: boolean }>;
          onError: (err: Error | null) => void;
        };
        const replyOptions = params.replyOptions as {
          onPartialReply: (p: { text?: string; delta?: string }) => Promise<void>;
        };
        for (const text of opts.partials ?? []) {
          await replyOptions.onPartialReply({ text, delta: text });
        }
        if (opts.error) {
          dispatcherOptions.onError(new Error(opts.error));
          return;
        }
        if (opts.deliver !== undefined) {
          await dispatcherOptions.deliver({ text: opts.deliver });
        }
      },
    },
  };
}

function makeCtx(): GatewayContext {
  return { cfg: {}, log: makeLog() };
}

function chatPollEntry(overrides: Record<string, unknown> = {}) {
  return {
    type: "request",
    runId: "run-1",
    sessionKey: "py:RZR_alice:default",
    userId: "RZR_alice",
    method: "POST",
    path: "/v1/chat/completions",
    headers: { "content-type": "application/json" },
    body: b64({ messages: [{ role: "user", content: "hello" }], user: "RZR_alice", openclaw: {} }),
    ...overrides,
  };
}

describe("dispatchChat", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async (_url: string, _init?: { body?: string }) => ({ ok: true, status: 200, statusText: "OK" }));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    setActiveRequest(null);
    setCurrentReplyGuidance(null);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function respondBodies(): Array<Record<string, unknown>> {
    return fetchMock.mock.calls
      .filter(([url]) => String(url).endsWith("/api/respond"))
      .map(([, init]) => JSON.parse((init as { body: string }).body));
  }

  it("decodes the base64 body and posts an `end` with the delivered text", async () => {
    const log = makeLog();
    await dispatchRequest(chatPollEntry(), makeState(), makeCtx(), log, makeChannelRuntime({ deliver: "Hi there" }));

    const ends = respondBodies().filter((b) => b.type === "end");
    expect(ends).toHaveLength(1);
    expect(ends[0]).toMatchObject({
      type: "end",
      text: "Hi there",
      runId: "run-1",
      sessionKey: "py:RZR_alice:default",
      userId: "RZR_alice",
    });
  });

  it("streams partial chunks before the end, each carrying the respond context", async () => {
    await dispatchRequest(
      chatPollEntry(),
      makeState(),
      makeCtx(),
      makeLog(),
      makeChannelRuntime({ partials: ["He", "Hello"], deliver: "Hello world" }),
    );

    const bodies = respondBodies();
    const chunks = bodies.filter((b) => b.type === "chunk");
    expect(chunks.map((c) => c.text)).toEqual(["He", "Hello"]);
    for (const c of chunks) {
      expect(c).toMatchObject({ runId: "run-1", sessionKey: "py:RZR_alice:default", userId: "RZR_alice" });
    }
    // end still fires after the chunks
    expect(bodies.filter((b) => b.type === "end")).toHaveLength(1);
  });

  it("suppresses chunks once `end` has been sent (sentFinal guard)", async () => {
    // A runtime that delivers the end, THEN tries to stream a late partial.
    const runtime: ChannelRuntime = {
      routing: { buildAgentSessionKey: () => "k" },
      session: { resolveStorePath: () => "/tmp/s.json", recordInboundSession: vi.fn(async () => {}) },
      reply: {
        dispatchReplyWithBufferedBlockDispatcher: async (params: Record<string, unknown>) => {
          const d = params.dispatcherOptions as { deliver: (b: { text?: string }) => Promise<unknown> };
          const r = params.replyOptions as { onPartialReply: (p: { text?: string }) => Promise<void> };
          await d.deliver({ text: "final answer" });
          await r.onPartialReply({ text: "late chunk" }); // must be dropped
        },
      },
    };
    await dispatchRequest(chatPollEntry(), makeState(), makeCtx(), makeLog(), runtime);

    const bodies = respondBodies();
    expect(bodies.filter((b) => b.type === "end")).toHaveLength(1);
    expect(bodies.filter((b) => b.type === "chunk")).toHaveLength(0);
  });

  it("posts an `error` (not end) when the runtime errors before delivering", async () => {
    await dispatchRequest(
      chatPollEntry(),
      makeState(),
      makeCtx(),
      makeLog(),
      makeChannelRuntime({ error: "boom" }),
    );

    const bodies = respondBodies();
    const errors = bodies.filter((b) => b.type === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ type: "error", text: "boom", runId: "run-1" });
    expect(bodies.filter((b) => b.type === "end")).toHaveLength(0);
  });

  it("posts a bare `end` when the runtime produces nothing and no error", async () => {
    await dispatchRequest(chatPollEntry(), makeState(), makeCtx(), makeLog(), makeChannelRuntime({}));
    const ends = respondBodies().filter((b) => b.type === "end");
    expect(ends).toHaveLength(1);
    expect(ends[0].text).toBeUndefined();
  });

  it("extracts and trims guidanceForLLM, exposing it to the hook during dispatch", async () => {
    let seenGuidance: string | null | undefined;
    const runtime: ChannelRuntime = {
      routing: { buildAgentSessionKey: () => "k" },
      session: { resolveStorePath: () => "/tmp/s.json", recordInboundSession: vi.fn(async () => {}) },
      reply: {
        dispatchReplyWithBufferedBlockDispatcher: async (params: Record<string, unknown>) => {
          // Capture the module-level guidance the before_prompt_build hook reads.
          const { getCurrentReplyGuidance } = await import("../state.js");
          seenGuidance = getCurrentReplyGuidance();
          const d = params.dispatcherOptions as { deliver: (b: { text?: string }) => Promise<unknown> };
          await d.deliver({ text: "ok" });
        },
      },
    };
    const entry = chatPollEntry({
      body: b64({ messages: [{ role: "user", content: "hi" }], user: "RZR_alice", openclaw: { guidanceForLLM: "  be brief  " } }),
    });
    await dispatchRequest(entry, makeState(), makeCtx(), makeLog(), runtime);
    expect(seenGuidance).toBe("be brief");

    // ...and it's cleared after dispatch so it can't leak into a later turn.
    const { getCurrentReplyGuidance } = await import("../state.js");
    expect(getCurrentReplyGuidance()).toBeNull();
  });

  it("ignores an empty user message (no respond posted)", async () => {
    const entry = chatPollEntry({
      body: b64({ messages: [{ role: "user", content: "   " }], user: "RZR_alice" }),
    });
    await dispatchRequest(entry, makeState(), makeCtx(), makeLog(), makeChannelRuntime({ deliver: "should not run" }));
    expect(respondBodies()).toHaveLength(0);
  });

  it("does not throw on a malformed base64 body (regression guard)", async () => {
    // NOTE: dispatchChat currently lets a JSON.parse throw propagate. The poll
    // loop's .catch keeps the process alive, but a defensive guard here would be
    // better. This test documents the current behaviour: dispatchRequest rejects
    // rather than crashing the test runner, and posts nothing.
    const entry = chatPollEntry({ body: "!!!not-base64-json!!!" });
    await expect(
      dispatchRequest(entry, makeState(), makeCtx(), makeLog(), makeChannelRuntime({ deliver: "x" })),
    ).rejects.toBeInstanceOf(Error);
    expect(respondBodies()).toHaveLength(0);
  });
});

describe("dispatchRequest routing", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("routes /v1/chat/history to the history handler (reads history, not the reply runtime)", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: { body?: string }) => ({ ok: true, status: 200, statusText: "OK" }));
    vi.stubGlobal("fetch", fetchMock);

    const dispatchReply = vi.fn(async () => {});
    const runtime: ChannelRuntime = {
      routing: { buildAgentSessionKey: () => "k" },
      session: { resolveStorePath: () => "/tmp/s.json", recordInboundSession: vi.fn(async () => {}) },
      reply: { dispatchReplyWithBufferedBlockDispatcher: dispatchReply },
    };
    const entry = chatPollEntry({
      path: "/v1/chat/history",
      body: b64({ limit: 10 }),
    });
    await dispatchRequest(entry, makeState(), makeCtx(), makeLog(), runtime);

    // History path must not invoke the chat reply runtime.
    expect(dispatchReply).not.toHaveBeenCalled();
    // It posts a respond of type history or error (readHistory throws without a
    // real openclaw session store), but never type chunk/end.
    const types = fetchMock.mock.calls
      .filter(([url]) => String(url).endsWith("/api/respond"))
      .map(([, init]) => JSON.parse((init as { body: string }).body).type);
    expect(types.every((t: string) => t === "history" || t === "error")).toBe(true);
  });
});
