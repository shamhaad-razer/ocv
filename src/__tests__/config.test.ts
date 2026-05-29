import { describe, it, expect } from "vitest";
import { resolveRelayUrl, resolveToken, resolveAccount, normalizeAgentId, resolveDefaultAgentId } from "../config.js";

describe("resolveRelayUrl", () => {
  it("returns default https URL when no config provided", () => {
    expect(resolveRelayUrl({})).toBe("https://ocv.razer.ai");
  });

  it("normalizes legacy wss://.../_tunnel to https", () => {
    const cfg = { channels: { "cloud-relay": { relayUrl: "wss://ocv.razer.ai/_tunnel" } } };
    expect(resolveRelayUrl(cfg)).toBe("https://ocv.razer.ai");
  });

  it("normalizes ws://.../_tunnel to http", () => {
    const cfg = { channels: { "cloud-relay": { relayUrl: "ws://localhost:3000/_tunnel" } } };
    expect(resolveRelayUrl(cfg)).toBe("http://localhost:3000");
  });

  it("normalizes wss URL without /_tunnel suffix", () => {
    const cfg = { channels: { "cloud-relay": { relayUrl: "wss://ocv.razer.ai" } } };
    expect(resolveRelayUrl(cfg)).toBe("https://ocv.razer.ai");
  });

  it("passes through a clean https URL unchanged", () => {
    const cfg = { channels: { "cloud-relay": { relayUrl: "https://ocv.razer.ai" } } };
    expect(resolveRelayUrl(cfg)).toBe("https://ocv.razer.ai");
  });

  it("reads from plugins.entries fallback", () => {
    const cfg = { plugins: { entries: { "cloud-relay": { config: { relayUrl: "wss://custom.relay.ai/_tunnel" } } } } };
    expect(resolveRelayUrl(cfg)).toBe("https://custom.relay.ai");
  });
});

describe("resolveToken", () => {
  it("returns empty string when no token configured", () => {
    expect(resolveToken({})).toBe("");
  });

  it("reads token from channel config", () => {
    const cfg = { channels: { "cloud-relay": { token: "abc123" } } };
    expect(resolveToken(cfg)).toBe("abc123");
  });
});

describe("resolveAccount", () => {
  it("returns account with token and normalized relayUrl", () => {
    const cfg = { channels: { "cloud-relay": { token: "tok", relayUrl: "wss://ocv.razer.ai/_tunnel" } } };
    const account = resolveAccount(cfg);
    expect(account.token).toBe("tok");
    expect(account.relayUrl).toBe("https://ocv.razer.ai");
    expect(account.enabled).toBe(true);
    expect(account.configured).toBe(true);
    expect(account.accountId).toBe("default");
  });

  it("uses provided accountId", () => {
    const cfg = { channels: { "cloud-relay": { token: "tok" } } };
    const account = resolveAccount(cfg, "custom");
    expect(account.accountId).toBe("custom");
  });
});

describe("normalizeAgentId", () => {
  it("lowercases and strips invalid chars", () => {
    expect(normalizeAgentId("My Agent!")).toBe("my-agent");
  });

  it("returns default for empty input", () => {
    expect(normalizeAgentId("")).toBe("main");
    expect(normalizeAgentId(null as unknown as string)).toBe("main");
  });

  it("trims leading/trailing hyphens", () => {
    expect(normalizeAgentId("--test--")).toBe("test");
  });
});

describe("resolveDefaultAgentId", () => {
  it("returns first agent id when no default marked", () => {
    const cfg = { agents: { list: [{ id: "alpha" }, { id: "beta" }] } };
    expect(resolveDefaultAgentId(cfg)).toBe("alpha");
  });

  it("returns default-marked agent", () => {
    const cfg = { agents: { list: [{ id: "alpha" }, { id: "beta", default: true }] } };
    expect(resolveDefaultAgentId(cfg)).toBe("beta");
  });

  it("returns 'main' when no agents configured", () => {
    expect(resolveDefaultAgentId({})).toBe("main");
  });
});
