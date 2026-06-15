import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the node fs and the (aliased) host session-store-runtime so readHistory
// can be exercised without a real openclaw session store or transcript file.
const readFileMock = vi.fn();
vi.mock("node:fs/promises", () => ({ readFile: (...a: unknown[]) => readFileMock(...a) }));

const getSessionEntryMock = vi.fn();
vi.mock("openclaw/plugin-sdk/session-store-runtime", () => ({
  getSessionEntry: (...a: unknown[]) => getSessionEntryMock(...a),
  resolveSessionTranscriptPathInDir: (sessionId: string, dir: string) => `${dir}/${sessionId}.ndjson`,
  resolveStorePath: (store: string | undefined, opts: { agentId: string }) =>
    store || `/tmp/${opts.agentId}/store.json`,
}));

import { readHistory } from "../history.js";
import type { ChannelRuntime, Log } from "../types.js";

function makeLog(): Log {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

const channelRuntime = {
  routing: { buildAgentSessionKey: () => "agent-session-key" },
} as unknown as ChannelRuntime;

function ndjson(...lines: unknown[]): string {
  return lines.map((l) => JSON.stringify(l)).join("\n");
}

describe("readHistory", () => {
  beforeEach(() => {
    readFileMock.mockReset();
    getSessionEntryMock.mockReset();
  });
  afterEach(() => vi.restoreAllMocks());

  it("returns [] when there is no session entry", async () => {
    getSessionEntryMock.mockReturnValue(undefined);
    const out = await readHistory({ cfg: {}, channelRuntime, userId: "RZR_alice", log: makeLog() });
    expect(out).toEqual([]);
    expect(readFileMock).not.toHaveBeenCalled();
  });

  it("returns [] when the transcript file is missing (ENOENT)", async () => {
    getSessionEntryMock.mockReturnValue({ sessionId: "sess-1" });
    const enoent = Object.assign(new Error("missing"), { code: "ENOENT" });
    readFileMock.mockRejectedValue(enoent);
    const out = await readHistory({ cfg: {}, channelRuntime, userId: "RZR_alice", log: makeLog() });
    expect(out).toEqual([]);
  });

  it("parses NDJSON and keeps only user/assistant messages with content", async () => {
    getSessionEntryMock.mockReturnValue({ sessionId: "sess-1" });
    readFileMock.mockResolvedValue(
      ndjson(
        { id: "m1", type: "message", message: { role: "user", content: "hi" }, timestamp: 1000 },
        { id: "m2", type: "message", message: { role: "assistant", content: "hello" }, timestamp: 2000 },
        { id: "m3", type: "event", message: { role: "user", content: "ignored — not a message" } },
        { id: "m4", type: "message", message: { role: "system", content: "skip system" } },
        { id: "m5", type: "message", message: { role: "user", content: "" } }, // empty → dropped
        "   ", // blank line → skipped
        "{not json", // unparseable → skipped
      ),
    );
    const out = await readHistory({ cfg: {}, channelRuntime, userId: "RZR_alice", log: makeLog() });
    expect(out).toEqual([
      { id: "m1", role: "user", content: "hi", timestamp: 1000 },
      { id: "m2", role: "assistant", content: "hello", timestamp: 2000 },
    ]);
  });

  it("flattens array content blocks, joining text parts", async () => {
    getSessionEntryMock.mockReturnValue({ sessionId: "sess-1" });
    readFileMock.mockResolvedValue(
      ndjson({
        id: "m1",
        type: "message",
        message: { role: "assistant", content: [{ type: "text", text: "Hello " }, { type: "image" }, { type: "text", text: "world" }] },
      }),
    );
    const out = await readHistory({ cfg: {}, channelRuntime, userId: "RZR_alice", log: makeLog() });
    expect(out).toEqual([{ id: "m1", role: "assistant", content: "Hello world", timestamp: undefined }]);
  });

  it("applies the limit by slicing the tail", async () => {
    getSessionEntryMock.mockReturnValue({ sessionId: "sess-1" });
    readFileMock.mockResolvedValue(
      ndjson(
        { id: "a", type: "message", message: { role: "user", content: "one" } },
        { id: "b", type: "message", message: { role: "assistant", content: "two" } },
        { id: "c", type: "message", message: { role: "user", content: "three" } },
      ),
    );
    const out = await readHistory({ cfg: {}, channelRuntime, userId: "RZR_alice", limit: 2, log: makeLog() });
    expect(out.map((m) => m.content)).toEqual(["two", "three"]);
  });
});
