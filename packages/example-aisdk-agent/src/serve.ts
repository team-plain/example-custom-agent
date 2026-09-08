import { verifyPlainWebhook } from "@team-plain/webhooks";
import { INTERNAL_EVENTS, PORT, SUPPORT_EVENTS, WEBHOOK_PATH, type Config } from "./config.ts";
import { handleDiscussion } from "./internal.ts";
import { handleThread } from "./support.ts";
import type { Plain } from "./plain.ts";

/**
 * Deliveries already handled, so a Plain retry does not act twice.
 *
 * Bounded and in memory, which is enough for an example and not enough for production: a second
 * instance does not see this set and a restart forgets it.
 */
const seen = new Set<string>();
const SEEN_LIMIT = 1000;

function alreadyHandled(id: string): boolean {
  if (seen.has(id)) return true;
  if (seen.size >= SEEN_LIMIT) seen.clear();
  seen.add(id);
  return false;
}

type Surface = "support" | "internal" | "ignored";

export function surfaceFor(eventType: string): Surface {
  if ((SUPPORT_EVENTS as readonly string[]).includes(eventType)) return "support";
  if ((INTERNAL_EVENTS as readonly string[]).includes(eventType)) return "internal";
  return "ignored";
}

/**
 * The four conditions from the docs, for a discussion message.
 *
 * Skip any one and the agent answers its own replies: its own messages come back as INBOUND, so
 * the message type check alone is what stops the loop.
 */
export function shouldAnswerDiscussion(payload: DiscussionPayload, myID: string): boolean {
  return (
    payload.discussion.type === "AGENT_SESSION" &&
    payload.discussion.agent?.id === myID &&
    payload.message.type === "OUTBOUND" &&
    payload.discussion.status !== "RESOLVED"
  );
}

/**
 * Whether a thread event is this agent's to act on.
 *
 * Assignment is the recommended pattern: the decision lives in Plain, where a workflow or a person
 * can change it without a deploy, and reporting attributes the work to the agent.
 */
export function shouldAnswerThread(payload: ThreadPayload, myID: string): boolean {
  return payload.thread.assignee?.id === myID;
}

export type DiscussionPayload = {
  eventType: string;
  discussion: { id: string; type: string; status: string; agent?: { id: string } | null };
  message: { id: string; type: string; text?: string | null; markdown?: string | null };
};

export type ThreadPayload = {
  eventType: string;
  thread: {
    id: string;
    assignee?: { id: string } | null;
    customer?: { id: string } | null;
  };
  /** Present on message events, and what a suggested reply must hang off. */
  timelineEntryId?: string | null;
};

export async function runServe(plain: Plain, config: Config, prompts: Prompts): Promise<void> {
  const myID = await plain.myMachineUserID();

  const active = [
    config.surfaces.support ? "support" : null,
    config.surfaces.internal ? "internal" : null,
  ].filter((s) => s !== null);
  if (active.length === 0) throw new Error("both surfaces are switched off, nothing to serve");

  const server = Bun.serve({
    port: PORT,
    fetch: async (request) => {
      const url = new URL(request.url);
      if (url.pathname !== WEBHOOK_PATH) return new Response(null, { status: 404 });
      if (request.method !== "POST") return new Response(null, { status: 405 });

      // The raw body, not parsed JSON: re-serialising changes the bytes the signature covers.
      const raw = await request.text();
      const verified = verifyPlainWebhook(
        raw,
        request.headers.get("plain-request-signature") ?? "",
        config.secret,
      );
      if (verified.error) return new Response(verified.error.message, { status: 400 });

      const payload = verified.data.payload as unknown as { eventType: string };
      dispatch(plain, config, prompts, myID, payload);

      // 200 before the work: Plain retries a slow delivery, and a turn outlives the request.
      return new Response(null, { status: 200 });
    },
  });

  console.log(`listening on :${server.port}${WEBHOOK_PATH}`);
  console.log(`surfaces: ${active.join(", ")}`);
  console.log(`machine user: ${myID}`);
}

function dispatch(
  plain: Plain,
  config: Config,
  prompts: Prompts,
  myID: string,
  payload: { eventType: string },
): void {
  const surface = surfaceFor(payload.eventType);

  if (surface === "internal" && config.surfaces.internal) {
    const message = payload as unknown as DiscussionPayload;
    if (payload.eventType !== "discussion.message_created") return;
    if (!shouldAnswerDiscussion(message, myID)) return;
    if (alreadyHandled(message.message.id)) return;

    const text = (message.message.markdown ?? message.message.text ?? "").trim();
    if (text === "") return;

    void handleDiscussion(plain, prompts.internal, text, {
      discussionID: message.discussion.id,
      gated: config.gated.internal,
    }).catch((err) => console.error("discussion turn failed:", err));
    return;
  }

  if (surface === "support" && config.surfaces.support) {
    const event = payload as unknown as ThreadPayload;
    if (!shouldAnswerThread(event, myID)) return;
    if (alreadyHandled(`${payload.eventType}:${event.thread.id}:${event.timelineEntryId ?? ""}`)) {
      return;
    }

    const customerID = event.thread.customer?.id;
    if (customerID === undefined) return;

    void handleThread(plain, prompts.support, {
      threadID: event.thread.id,
      customerID,
      timelineEntryID: event.timelineEntryId ?? null,
      gated: config.gated.support,
    }).catch((err) => console.error("thread turn failed:", err));
  }
}

export type Prompts = { support: string; internal: string };
