import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { postPush, postRespond } from "../http-client.js";
import type { Log, RelayState } from "../types.js";

function makeState(): RelayState {
  return {
    stopped: false,
    reconnectAttempt: 0,
    pollAbort: null,
    tokenPollTimer: null,
    lastKnownToken: "tok-123",
    username: "RZR_alice",
    relayHttpUrl: "https://relay.test",
    token: "tok-123",
  };
}

function makeLog(): Log {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe("postRespond", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn(async () => ({ ok: true, status: 200, statusText: "OK" }));
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("POSTs to /api/respond with the bearer token and JSON body", async () => {
    await postRespond(
      makeState(),
      { type: "end", text: "hi", runId: "r1", sessionKey: "py:RZR_alice:default", userId: "RZR_alice" },
      makeLog(),
    );
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://relay.test/api/respond");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer tok-123");
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(init.body)).toEqual({
      type: "end", text: "hi", runId: "r1", sessionKey: "py:RZR_alice:default", userId: "RZR_alice",
    });
  });

  it("warns but does not throw on a non-ok response", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 503, statusText: "Service Unavailable" });
    const log = makeLog();
    await expect(
      postRespond(makeState(), { type: "chunk", text: "x", runId: "r", sessionKey: "s", userId: "u" }, log),
    ).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("503"));
  });

  it("swallows network errors (logs warn, never throws)", async () => {
    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const log = makeLog();
    await expect(
      postRespond(makeState(), { type: "error", text: "e", runId: "r", sessionKey: "s", userId: "u" }, log),
    ).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("ECONNREFUSED"));
  });
});

describe("postPush", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn(async () => ({ ok: true, status: 200, statusText: "OK" }));
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("POSTs to /api/push with bearer auth and returns true on ok", async () => {
    const ok = await postPush(
      makeState(),
      { userId: "RZR_alice", event: "cron.fired", payload: { foo: "bar" } },
      makeLog(),
    );
    expect(ok).toBe(true);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://relay.test/api/push");
    expect(init.headers.Authorization).toBe("Bearer tok-123");
    expect(JSON.parse(init.body)).toEqual({ userId: "RZR_alice", event: "cron.fired", payload: { foo: "bar" } });
  });

  it("returns false on a non-ok response", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 403, statusText: "Forbidden", text: async () => "nope" });
    const ok = await postPush(makeState(), { userId: "u", event: "e", payload: {} }, makeLog());
    expect(ok).toBe(false);
  });

  it("returns false (not throw) on a network error", async () => {
    fetchMock.mockRejectedValueOnce(new Error("timeout"));
    const ok = await postPush(makeState(), { userId: "u", event: "e", payload: {} }, makeLog());
    expect(ok).toBe(false);
  });
});
