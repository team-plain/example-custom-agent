import { verifyPlainWebhook } from "@team-plain/webhooks";
import type { DiscussionMessageCreatedPublicEventPayload } from "@team-plain/webhooks";
import { PORT, WEBHOOK_PATH, type Config } from "./config.ts";
import { handleDiscussion } from "./agent.ts";
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

/**
 * The SDK's own payload type, not a hand-written one.
 *
 * An invented shape typechecks and then reads undefined on the first real delivery.
 */
export type DiscussionPayload = DiscussionMessageCreatedPublicEventPayload;

/**
 * The four conditions from the docs, and which one said no.
 *
 * Null means answer it. A string is the reason, because "not this agent's turn" sent people
 * hunting: a RESOLVED Sidekick session looks identical to a broken agent from the outside.
 */
export function whyNotAnswering(payload: DiscussionPayload, myID: string): string | null {
  if (payload.discussion.type !== "AGENT_SESSION") {
    return `discussion type is ${payload.discussion.type}, not AGENT_SESSION`;
  }
  if (payload.discussion.agent?.id !== myID) {
    return `discussion belongs to agent ${payload.discussion.agent?.id ?? "nobody"}, not ${myID}`;
  }
  // The loop guard. Its own replies come back as INBOUND, so without this it answers itself.
  if (payload.message.type !== "OUTBOUND") {
    return `message is ${payload.message.type}, so it is not a person's turn`;
  }
  if (payload.discussion.status === "RESOLVED") {
    return "the discussion is RESOLVED, so start a new Ask Sidekick session to continue";
  }
  return null;
}

/** The four conditions as a boolean, for callers that do not need the reason. */
export function shouldAnswerDiscussion(payload: DiscussionPayload, myID: string): boolean {
  return whyNotAnswering(payload, myID) === null;
}

/** The customer thread the discussion was opened on, or null when it was opened on nothing. */
export function threadIDOf(payload: DiscussionPayload): string | null {
  return payload.discussion.threadId ?? null;
}

export async function runServe(plain: Plain, config: Config, systemPrompt: string): Promise<void> {
  const myID = await plain.myMachineUserID();

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
      console.log(`<- ${payload.eventType}`);
      dispatch(plain, systemPrompt, myID, payload);

      // 200 before the work: Plain retries a slow delivery, and a turn outlives the request.
      return new Response(null, { status: 200 });
    },
  });

  console.log(`listening on :${server.port}${WEBHOOK_PATH}`);
  console.log(`machine user: ${myID}`);
}

function dispatch(
  plain: Plain,
  systemPrompt: string,
  myID: string,
  payload: { eventType: string },
): void {
  if (payload.eventType !== "discussion.message_created") {
    return skip(`nothing to do for ${payload.eventType}`);
  }

  const message = payload as unknown as DiscussionPayload;
  const why = whyNotAnswering(message, myID);
  if (why !== null) return skip(why);
  if (alreadyHandled(message.message.id)) return skip("already handled");

  const text = (message.message.markdown ?? message.message.text ?? "").trim();
  if (text === "") return skip("empty message");

  const threadID = threadIDOf(message);
  console.log(`   turn on ${message.discussion.id} (thread ${threadID ?? "none"})`);

  void handleDiscussion(plain, systemPrompt, text, {
    discussionID: message.discussion.id,
    threadID,
  })
    .then((r) => console.log(`   done: answered=${r.answered} steps=${r.steps}`))
    .catch((err) => console.error("   turn failed:", err));
}

// Says why a delivery was dropped. Silence is the worst answer when nothing appears to happen.
function skip(why: string): void {
  console.log(`   skipped: ${why}`);
}
