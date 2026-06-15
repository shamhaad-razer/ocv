import { afterEach, describe, expect, it, vi } from "vitest";
import { startGatewayAccount } from "../gateway.js";
import { RECONNECT_DELAYS } from "../constants.js";
import type { GatewayContext, Log } from "../types.js";

// Exercises the poll loop in startGatewayAccount by mocking global fetch and
// feeding it canned poll responses. The loop is driven to a stop either by a
// 401 (sets stopped) or by aborting ctx.abortSignal — and the returned promise
// only resolves once the abort handler runs, so every test aborts at the end.
//
// Note: a poll that "hangs" (long-poll in flight) must reject when its
// AbortController fires, exactly like real fetch — otherwise abort() can't
// unstick the awaited fetch. hangUntilAbort models that.

function makeLog(): Log {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function abortError(): Error {
  const e = new Error("aborted");
  e.name = "AbortError";
  return e;
}

function hangUntilAbort(signal?: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    signal?.addEventListener("abort", () => reject(abortError()));
  });
}

function resp(init: { status?: number; ok?: boolean; json?: unknown; headers?: Record<string, string> }) {
  const headers = new Map(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    status: init.status ?? 200,
    ok: init.ok ?? (init.status ? init.status >= 200 && init.status < 300 : true),
    json: async () => init.json ?? {},
    headers: { get: (k: string) => headers.get(k.toLowerCase()) ?? null },
  };
}

function ctxWith(overrides: Partial<GatewayContext> = {}): GatewayContext {
  return {
    cfg: { channels: { "cloud-relay": { token: "tok", relayUrl: "https://relay.test" } } },
    log: makeLog(),
    ...overrides,
  };
}

describe("startGatewayAccount poll loop", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("throws when no token is configured", async () => {
    await expect(startGatewayAccount({ cfg: {}, log: makeLog() })).rejects.toThrow(/token not configured/i);
  });

  it("sends Authorization: Bearer and stops the loop on 401", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: { headers?: Record<string, string> }) =>
      resp({ status: 401, ok: false }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const ac = new AbortController();
    const log = makeLog();
    const done = startGatewayAccount(
      ctxWith({
        cfg: { channels: { "cloud-relay": { token: "tok-xyz", relayUrl: "https://relay.test" } } },
        log,
        abortSignal: ac.signal,
      }),
    );

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://relay.test/api/poll");
    expect((init as { headers: Record<string, string> }).headers.Authorization).toBe("Bearer tok-xyz");
    await vi.waitFor(() => expect(log.error).toHaveBeenCalledWith(expect.stringContaining("401")));

    ac.abort();
    await done;
  });

  it("captures x-username from a 204 then keeps polling with ?username= until aborted", async () => {
    let calls = 0;
    const fetchMock = vi.fn(async (_url: string, init?: { signal?: AbortSignal }) => {
      calls++;
      if (calls === 1) return resp({ status: 204, headers: { "x-username": "RZR_alice" } });
      return hangUntilAbort(init?.signal);
    });
    vi.stubGlobal("fetch", fetchMock);

    const ac = new AbortController();
    const done = startGatewayAccount(ctxWith({ abortSignal: ac.signal }));

    await vi.waitFor(() => expect(calls).toBeGreaterThanOrEqual(2));
    expect(String(fetchMock.mock.calls[1][0])).toContain("/api/poll?username=RZR_alice");

    ac.abort();
    await done;
  });

  it("dispatches a 200 work entry to the reply runtime and posts the result", async () => {
    const body = Buffer.from(
      JSON.stringify({ messages: [{ role: "user", content: "hi" }], user: "RZR_alice", openclaw: {} }),
    ).toString("base64");
    let calls = 0;
    const fetchMock = vi.fn(async (url: string, init?: { signal?: AbortSignal }) => {
      if (String(url).endsWith("/api/respond")) return resp({ ok: true, status: 200 });
      calls++;
      if (calls === 1) {
        return resp({
          status: 200,
          json: {
            type: "request", runId: "run-1", sessionKey: "py:RZR_alice:default", userId: "RZR_alice",
            method: "POST", path: "/v1/chat/completions", headers: {}, body, username: "RZR_alice",
          },
        });
      }
      return hangUntilAbort(init?.signal);
    });
    vi.stubGlobal("fetch", fetchMock);

    const dispatchReply = vi.fn(async (params: Record<string, unknown>) => {
      const d = params.dispatcherOptions as { deliver: (b: { text?: string }) => Promise<unknown> };
      await d.deliver({ text: "Hello" });
    });
    const channelRuntime = {
      routing: { buildAgentSessionKey: () => "k" },
      session: { resolveStorePath: () => "/tmp/s.json", recordInboundSession: vi.fn(async () => {}) },
      reply: { dispatchReplyWithBufferedBlockDispatcher: dispatchReply },
    };

    const ac = new AbortController();
    const done = startGatewayAccount(ctxWith({ abortSignal: ac.signal, channelRuntime: channelRuntime as never }));

    await vi.waitFor(() => expect(dispatchReply).toHaveBeenCalled());
    await vi.waitFor(() =>
      expect(fetchMock.mock.calls.some(([u]) => String(u).endsWith("/api/respond"))).toBe(true),
    );

    ac.abort();
    await done;
  });

  it("backs off using RECONNECT_DELAYS on network errors, then retries", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const fetchMock = vi.fn(async (_url: string, init?: { signal?: AbortSignal }) => {
      calls++;
      if (calls <= 2) throw new Error("ECONNREFUSED");
      return hangUntilAbort(init?.signal);
    });
    vi.stubGlobal("fetch", fetchMock);

    const ac = new AbortController();
    const log = makeLog();
    const done = startGatewayAccount(ctxWith({ abortSignal: ac.signal, log }));

    // Flush microtasks: first fetch rejects, backoff RECONNECT_DELAYS[0] is scheduled.
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(RECONNECT_DELAYS[0]);
    expect(calls).toBe(2);
    // Second failure → backoff RECONNECT_DELAYS[1] before the 3rd call.
    await vi.advanceTimersByTimeAsync(RECONNECT_DELAYS[1]);
    expect(calls).toBe(3);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("retry in"));

    ac.abort();
    await vi.advanceTimersByTimeAsync(0);
    await done;
  });
});
