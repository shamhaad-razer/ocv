import type { Log, RelayState } from "./types.js";

export async function postRespond(
  state: RelayState,
  body: { requestId: string; type: "chunk" | "end" | "error"; text?: string },
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
  try {
    const resp = await fetch(`${state.relayHttpUrl}/api/push`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${state.token}`,
      },
      body: JSON.stringify(body),
    });
    return resp.ok;
  } catch (err) {
    log.warn(`[cloud-relay] postPush error: ${(err as Error).message}`);
    return false;
  }
}
