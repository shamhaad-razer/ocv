import { postRespond } from "./http-client.js";
import { getPluginRuntime } from "./state.js";
import type { GatewayContext, Log, RelayState } from "./types.js";

const TERMINAL_STATUSES = new Set([
  "succeeded",
  "failed",
  "timed_out",
  "cancelled",
  "lost",
]);

export async function dispatchCancel(
  msg: Record<string, unknown>,
  state: RelayState,
  ctx: GatewayContext,
  log: Log,
): Promise<void> {
  const runId = (msg.runId as string) || "";
  const sessionKey = (msg.sessionKey as string) || "";
  const userId = (msg.userId as string) || state.username || "browser-user";
  const reason = (msg.reason as string) || "user requested cancel";

  if (!sessionKey) {
    log.warn(`[cloud-relay] cancel missing sessionKey: user=${userId} runId=${runId}`);
    await postRespond(state, { type: "error", text: "cancel missing sessionKey", runId, sessionKey, userId }, log);
    return;
  }

  const tasks = getPluginRuntime()?.tasks?.runs;
  if (!tasks) {
    log.warn("[cloud-relay] cancel: tasks runtime unavailable");
    await postRespond(state, { type: "error", text: "tasks runtime unavailable", runId, sessionKey, userId }, log);
    return;
  }

  const bound = tasks.bindSession({ sessionKey });
  const active = bound.list().filter((task) => !TERMINAL_STATUSES.has(task.status));

  if (active.length === 0) {
    log.info(`[cloud-relay] cancel: no active task for sessionKey=${sessionKey}`);
    await postRespond(state, { type: "end", text: "", runId, sessionKey, userId }, log);
    return;
  }

  const cancelled: string[] = [];
  for (const task of active) {
    const result = await bound.cancel({ taskId: task.id, cfg: ctx.cfg });
    if (result.cancelled) {
      cancelled.push(task.id);
    } else {
      log.warn(`[cloud-relay] cancel failed: taskId=${task.id} reason=${result.reason || "unknown"}`);
    }
  }

  log.info(
    `[cloud-relay] cancel done: sessionKey=${sessionKey} cancelled=${cancelled.length}/${active.length} reason="${reason}"`,
  );
  await postRespond(state, { type: "end", text: "", runId, sessionKey, userId }, log);
}
