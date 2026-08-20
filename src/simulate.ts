import { createHmac } from "node:crypto";
import {
  DISCUSSION_MESSAGE_CREATED_EVENT,
  WEBHOOK_PATH,
  WEBHOOK_TARGET_VERSION,
  type Config,
} from "./config.ts";
import type { PlainClient } from "./plain.ts";
import { SIGNATURE_HEADER } from "./webhook.ts";

/**
 * Posts a synthetic, correctly signed delivery at the running server. It exercises signature
 * checking, filtering and the Claude turn without needing anything from Plain, which is the fastest
 * way to tell a local bug from a webhook that never arrived.
 */
export async function runSimulate(
  client: PlainClient,
  config: Config,
  question: string,
): Promise<void> {
  if (config.secret === "") {
    console.log("set PLAIN_WEBHOOK_SECRET in .env first: the simulated delivery has to be signed");
    return;
  }

  let me;
  try {
    me = await client.myMachineUser();
  } catch (err) {
    console.log(`could not identify the API key: ${err instanceof Error ? err.message : err}`);
    return;
  }

  const now = new Date().toISOString();
  const raw = JSON.stringify({
    id: "ev_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    type: DISCUSSION_MESSAGE_CREATED_EVENT,
    timestamp: now,
    workspaceId: "w_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    webhookMetadata: { webhookTargetVersion: WEBHOOK_TARGET_VERSION },
    payload: {
      eventType: DISCUSSION_MESSAGE_CREATED_EVENT,
      discussion: {
        id: "td_01ARZ3NDEKTSV4RRFFQ69G5FAV",
        type: "AGENT_SESSION",
        status: "OPEN",
        threadId: null,
        agent: { id: me.id, fullName: me.fullName, publicName: me.publicName },
      },
      message: {
        id: "tdm_01ARZ3NDEKTSV4RRFFQ69G5FAV",
        type: "OUTBOUND",
        markdown: question,
        createdBy: { actorType: "user", userId: "u_01ARZ3NDEKTSV4RRFFQ69G5FAV" },
        createdAt: now,
      },
    },
  });

  const url = `http://localhost:${config.port}${WEBHOOK_PATH}`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [SIGNATURE_HEADER]: createHmac("sha256", config.secret).update(raw).digest("hex"),
      },
      body: raw,
      signal: AbortSignal.timeout(15_000),
    });
    console.log(`posted a simulated delivery to ${url} -> ${res.status} ${res.statusText}`);
  } catch (err) {
    console.log(
      `could not reach the agent on ${url} (is \`serve\` running?): ${err instanceof Error ? err.message : err}`,
    );
    return;
  }
  console.log(
    "watch the serve logs: the answer will fail to post unless the key has the discussion permissions",
  );
}
