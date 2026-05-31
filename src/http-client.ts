import type { Log, RelayState } from "./types.js";

export interface RespondBody {
  type: "end" | "error" | "history";
  text?: string;
  messages?: unknown[];
  runId: string;
  sessionKey: string;
  userId: string;
}

export async function postRespond(
  state: RelayState,
  body: RespondBody,
  log: Log,
): Promise<void> {
  try {
    const resp = await fetch(`${state.relayHttpUrl}/api/respond`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${state.token}`,
      },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      log.warn(`[cloud-relay] postRespond failed: ${resp.status} ${resp.statusText}`);
    }
  } catch (err) {
    log.warn(`[cloud-relay] postRespond error: ${(err as Error).message}`);
  }
}

export async function postPush(
  state: RelayState,
  body: { userId: string; event: string; payload: Record<string, unknown> },
  log: Log,
): Promise<boolean> {
  const url = `${state.relayHttpUrl}/api/push`;
  try {
    log.info(`[cloud-relay] postPush -> ${url} userId=${body.userId} event=${body.event}`);
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${state.token}`,
      },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      log.warn(`[cloud-relay] postPush failed: ${resp.status} ${resp.statusText} body=${text.slice(0, 200)}`);
    } else {
      log.info(`[cloud-relay] postPush ok: ${resp.status}`);
    }
    return resp.ok;
  } catch (err) {
    log.warn(`[cloud-relay] postPush error: ${(err as Error).message}`);
    return false;
  }
}
