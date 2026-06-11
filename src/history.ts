import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  getSessionEntry,
  resolveSessionTranscriptPathInDir,
  resolveStorePath,
  // @ts-expect-error: openclaw is the host runtime, resolved at load time, not in this package's deps
} from "openclaw/plugin-sdk/session-store-runtime";
import { CHANNEL_ID } from "./constants.js";
import { resolveDefaultAgentId } from "./config.js";
import type { ChannelRuntime, Log } from "./types.js";

export interface HistoryMessage {
  id: string;
  role: string;
  content: string;
  timestamp?: number;
}

export interface ReadHistoryParams {
  cfg: Record<string, unknown>;
  channelRuntime: ChannelRuntime;
  userId: string;
  limit?: number;
  log: Log;
}

export async function readHistory(params: ReadHistoryParams): Promise<HistoryMessage[]> {
  const { cfg, channelRuntime, userId, log } = params;
  const limit = params.limit && params.limit > 0 ? params.limit : 500;

  const agentId = resolveDefaultAgentId(cfg);
  const sessionKey = channelRuntime.routing.buildAgentSessionKey({
    agentId,
    channel: CHANNEL_ID,
    peer: { id: userId, type: "direct" },
    dmScope: (cfg?.session as Record<string, unknown>)?.dmScope || "per-channel-peer",
  });

  const storePath = resolveStorePath(
    (cfg?.session as Record<string, unknown>)?.store as string | undefined,
    { agentId },
  );
  const entry = getSessionEntry({ storePath, sessionKey });
  const sessionId = entry?.sessionId;
  if (!sessionId) {
    log.info(`[cloud-relay] readHistory: no sessionId for sessionKey=${sessionKey}`);
    return [];
  }

  const transcriptPath = resolveSessionTranscriptPathInDir(sessionId, dirname(storePath));

  let raw: string;
  try {
    raw = await readFile(transcriptPath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      log.info(`[cloud-relay] readHistory: transcript missing at ${transcriptPath}`);
      return [];
    }
    throw err;
  }

  // Two-pass build. The codex/agent-harness sometimes writes the same
  // user turn twice when a model call has to retry (rate-limit failover,
  // etc.) — the second user line carries the original line's id as its
  // parentId. We need to keep the original (the canonical inbound message
  // a human sent) and drop the retry copy, otherwise the browser's chat
  // history shows the user's message duplicated after a page reload.
  // Pass 1 collects every user-role line so we can match parentId
  // against prior user-role ids. Pass 2 emits the actual messages,
  // skipping the retries.
  const userIds = new Set<string>();
  const parsed: Array<{ id: string; role: string; content: string; parentId: string | undefined; timestamp: number | undefined }> = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (entry.type && entry.type !== "message") continue;
    const message = entry.message as Record<string, unknown> | undefined;
    if (!message) continue;
    const role = typeof message.role === "string" ? message.role : "";
    if (role !== "user" && role !== "assistant") continue;
    const content = flattenContent(message.content);
    if (!content) continue;
    const id = typeof entry.id === "string" ? entry.id : `${parsed.length}`;
    const parentId = typeof entry.parentId === "string" ? entry.parentId : undefined;
    if (role === "user") userIds.add(id);
    parsed.push({ id, role, content, parentId, timestamp: typeof entry.timestamp === "number" ? entry.timestamp : undefined });
  }

  const messages: HistoryMessage[] = [];
  for (const m of parsed) {
    // Drop user lines that are retry copies of an earlier user line.
    if (m.role === "user" && m.parentId && userIds.has(m.parentId)) continue;
    messages.push({ id: m.id, role: m.role, content: m.content, timestamp: m.timestamp });
  }

  return messages.slice(-limit);
}

function flattenContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === "string") {
      parts.push(block);
    } else if (block && typeof block === "object") {
      const b = block as Record<string, unknown>;
      if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
    }
  }
  return parts.join("");
}
