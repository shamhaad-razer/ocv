import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dispatchRequest } from "../dispatch.js";
import { postPush, postRespond } from "../http-client.js";
import { setActiveRequest, setCurrentReplyGuidance } from "../state.js";
import type { ChannelRuntime, GatewayContext, Log, RelayState } from "../types.js";

// Contract tests: validate the wire objects ocv PRODUCES (/api/respond bodies)
// against the shared schemas in ../../openclaw-contracts, so a drift between
// what ocv posts and what service-voice parses fails at test time.
//
// The contracts package is consumed by relative path; in a single-repo CI
// checkout the sibling dir is absent, so the whole suite skips rather than
// fails. (Phase 2 decides on a published/vendored distribution — see
// openclaw-contracts/README.md.)

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONTRACTS_DIR = path.resolve(HERE, "../../../testing/openclaw-contracts");
const HAS_CONTRACTS = existsSync(path.join(CONTRACTS_DIR, "index.json"));

const requireFromHere = createRequire(import.meta.url);

// Lazy: only load ajv + schemas when the contracts dir is present.
function makeValidator(schemaName: string) {
  const { loadSchema } = requireFromHere(path.join(CONTRACTS_DIR, "js/index.mjs"));
  // ajv is an ocv devDependency (see package.json).
  const Ajv = requireFromHere("ajv/dist/2020.js").default ?? requireFromHere("ajv/dist/2020.js");
  const ajv = new Ajv({ allErrors: true, strict: false });
  return ajv.compile(loadSchema(schemaName));
}

const describeContract = HAS_CONTRACTS ? describe : describe.skip;

function b64(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString("base64");
}
function makeState(): RelayState {
  return {
    stopped: false, reconnectAttempt: 0, pollAbort: null, tokenPollTimer: null,
    lastKnownToken: "tok", username: "RZR_alice", relayHttpUrl: "https://relay.test", token: "tok",
  };
}
function makeLog(): Log {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describeContract("ocv → contracts (respond-body)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let validate: ReturnType<typeof makeValidator>;

  beforeEach(() => {
    fetchMock = vi.fn(async () => ({ ok: true, status: 200, statusText: "OK" }));
    vi.stubGlobal("fetch", fetchMock);
    validate = makeValidator("respond-body");
  });
  afterEach(() => {
    setActiveRequest(null);
    setCurrentReplyGuidance(null);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function respondBodies() {
    return fetchMock.mock.calls
      .filter(([url]) => String(url).endsWith("/api/respond"))
      .map(([, init]) => JSON.parse((init as { body: string }).body));
  }

  it("every body postRespond sends conforms to respond-body schema", async () => {
    const ctx = { runId: "run-1", sessionKey: "py:RZR_alice:default", userId: "RZR_alice" };
    await postRespond(makeState(), { type: "chunk", text: "He", ...ctx }, makeLog());
    await postRespond(makeState(), { type: "end", text: "Hello", ...ctx }, makeLog());
    await postRespond(makeState(), { type: "end", ...ctx }, makeLog());
    await postRespond(makeState(), { type: "error", text: "boom", ...ctx }, makeLog());
    await postRespond(makeState(), { type: "history", messages: [], ...ctx }, makeLog());

    const bodies = respondBodies();
    expect(bodies).toHaveLength(5);
    for (const body of bodies) {
      expect(validate(body), JSON.stringify(validate.errors)).toBe(true);
    }
  });

  it("the chunk/end bodies a real dispatch produces conform to the schema", async () => {
    const runtime: ChannelRuntime = {
      routing: { buildAgentSessionKey: () => "k" },
      session: { resolveStorePath: () => "/tmp/s.json", recordInboundSession: vi.fn(async () => {}) },
      reply: {
        dispatchReplyWithBufferedBlockDispatcher: async (params: Record<string, unknown>) => {
          const r = params.replyOptions as { onPartialReply: (p: { text?: string }) => Promise<void> };
          const d = params.dispatcherOptions as { deliver: (b: { text?: string }) => Promise<unknown> };
          await r.onPartialReply({ text: "Hel" });
          await d.deliver({ text: "Hello" });
        },
      },
    };
    const entry = {
      type: "request", runId: "run-1", sessionKey: "py:RZR_alice:default", userId: "RZR_alice",
      method: "POST", path: "/v1/chat/completions", headers: {},
      body: b64({ messages: [{ role: "user", content: "hi" }], user: "RZR_alice", openclaw: {} }),
    };
    const ctx: GatewayContext = { cfg: {}, log: makeLog() };
    await dispatchRequest(entry, makeState(), ctx, makeLog(), runtime);

    for (const body of respondBodies()) {
      expect(validate(body), JSON.stringify(validate.errors)).toBe(true);
    }
  });
});

describeContract("ocv ← contracts (poll-entry / poll-body-decoded)", () => {
  it("a representative /api/poll entry validates, and its decoded body validates", () => {
    const entryValidate = makeValidator("poll-entry");
    const bodyValidate = makeValidator("poll-body-decoded");

    const decoded = { messages: [{ role: "user", content: "hi" }], user: "RZR_alice", openclaw: { guidanceForLLM: "be brief" } };
    const entry = {
      type: "request", runId: "run-1", sessionKey: "py:RZR_alice:default", userId: "RZR_alice",
      method: "POST", path: "/v1/chat/completions", headers: { "content-type": "application/json" },
      body: b64(decoded), username: "RZR_alice",
    };
    expect(entryValidate(entry), JSON.stringify(entryValidate.errors)).toBe(true);

    const reDecoded = JSON.parse(Buffer.from(entry.body, "base64").toString());
    expect(bodyValidate(reDecoded), JSON.stringify(bodyValidate.errors)).toBe(true);
  });
});
