import { defineChannel, POST } from "eve/channels";
import { parseInputResponses } from "eve/client";
import { verifyPlainWebhook } from "@team-plain/webhooks";
import { Plain } from "#lib/plain.js";

// Same path package example-coding-agent serves, so one webhook target works for either.
const WEBHOOK_PATH = "/plain/webhook";

const MESSAGE_CREATED = "discussion.message_created";
const APPROVAL_RESOLVED = "discussion.tool_call_approval_resolved";

// Confirmed against eve's own types: `approval.settled.outcome` is "approved" | "cancelled".
const APPROVE_OPTION = "approve";
const CANCEL_OPTION = "cancel";

/**
 * Deliveries already handled, so a Plain retry does not answer twice.
 *
 * Module-level and bounded because a first delivery has no session yet, so per-session channel
 * state cannot hold it. A real deployment needs shared storage instead: two instances do not see
 * each other's set, and a restart forgets everything.
 */
const seen = new Set<string>();
const SEEN_LIMIT = 1000;

/**
 * Plain toolCallId to eve requestId, for calls parked on an approval.
 *
 * Module-level for the same reason as `seen`: the approval webhook arrives on its own request,
 * outside any session, so a per-session channel state cannot answer it. Shared storage in a real
 * deployment, or a second instance drops the decision and the turn stays parked.
 */
const gated = new Map<string, string>();

function alreadyHandled(messageID: string): boolean {
  if (seen.has(messageID)) return true;
  if (seen.size >= SEEN_LIMIT) seen.clear();
  seen.add(messageID);
  return false;
}

let client: Plain | undefined;
let machineUserID: Promise<string> | undefined;

function plain(): Plain {
  if (client === undefined) {
    const apiKey = (process.env.PLAIN_API_KEY ?? "").trim();
    if (apiKey === "") throw new Error("set PLAIN_API_KEY in .env");
    client = new Plain(apiKey, (process.env.PLAIN_API_URL ?? "").trim() || undefined);
  }
  return client;
}

// Resolved once and reused: the id never changes for a given key, and the check runs per delivery.
function me(): Promise<string> {
  machineUserID ??= plain().myMachineUserID();
  return machineUserID;
}

/** The four conditions from the docs. Skip any one and the agent answers its own replies. */
function shouldAnswer(payload: PlainMessagePayload, myID: string): boolean {
  return (
    payload.discussion.type === "AGENT_SESSION" &&
    payload.discussion.agent?.id === myID &&
    payload.message.type === "OUTBOUND" &&
    payload.discussion.status !== "RESOLVED"
  );
}

// Narrow structural types for the two payloads used here. The webhooks package ships full types;
// these name only the fields this channel reads.
type PlainMessagePayload = {
  eventType: string;
  discussion: { id: string; type: string; status: string; agent?: { id: string } | null };
  message: { id: string; type: string; text?: string | null; markdown?: string | null };
};

type PlainApprovalPayload = {
  eventType: string;
  discussion: { id: string };
  toolCall: { toolCallId: string };
  approval: { status: string; reviewerNote?: string | null };
};

export default defineChannel({
  routes: [
    POST(WEBHOOK_PATH, async (request, { from, waitUntil }) => {
      // verifyPlainWebhook needs the raw body, not parsed JSON: parsing and re-serialising changes
      // the bytes the signature was computed over.
      const raw = await request.text();
      const signature = request.headers.get("plain-request-signature") ?? "";
      const secret = (process.env.PLAIN_WEBHOOK_SECRET ?? "").trim();

      const verified = verifyPlainWebhook(raw, signature, secret);
      if (verified.error) return new Response(verified.error.message, { status: 400 });

      const payload = verified.data.payload as unknown as { eventType: string };

      if (payload.eventType === APPROVAL_RESOLVED) {
        // Plain owns the decision, eve owns the parked turn, and requestId is the only thing that
        // joins them, which is why input.requested recorded the mapping.
        const resolved = payload as unknown as PlainApprovalPayload;
        const requestID = gated.get(resolved.toolCall.toolCallId);
        if (requestID === undefined) return new Response(null, { status: 200 });

        gated.delete(resolved.toolCall.toolCallId);
        const optionID = resolved.approval.status === "APPROVED" ? APPROVE_OPTION : CANCEL_OPTION;
        await from(resolved.discussion.id).respond(
          parseInputResponses([{ requestId: requestID, optionId: optionID }]),
          { auth: null },
        );
        return new Response(null, { status: 200 });
      }

      if (payload.eventType !== MESSAGE_CREATED) return new Response(null, { status: 200 });

      const message = payload as unknown as PlainMessagePayload;
      if (!shouldAnswer(message, await me())) return new Response(null, { status: 200 });
      if (alreadyHandled(message.message.id)) return new Response(null, { status: 200 });

      const text = (message.message.markdown ?? message.message.text ?? "").trim();
      if (text === "") return new Response(null, { status: 200 });

      // 200 first, work after: Plain retries a slow delivery, and a turn outlives the request.
      // from(discussion.id) creates the session on the first message and resumes it on later ones,
      // which is the whole discussion-to-session mapping.
      waitUntil(from(message.discussion.id).send(text, { auth: null }));
      return new Response(null, { status: 200 });
    }),
  ],

  events: {
    async "turn.started"(_event, channel) {
      await plain().setAgentStatus(discussionOf(channel), "IN_PROGRESS");
    },

    // One line on the Plain timeline per call the model makes, before it runs. Correlated by
    // callId because eve warns that calls arrive incrementally, not one event per step.
    async "actions.requested"(event, channel) {
      const discussionID = discussionOf(channel);
      for (const action of event.actions) {
        if (action.kind !== "tool-call") continue;
        await plain().upsertToolCall(discussionID, action.callId, "PENDING", describe(action));
      }
    },

    /**
     * The gate. eve has parked the turn; Plain shows the card and owns the decision.
     *
     * Only `tool-approval` becomes a Plain approval. A `question` or `session-limit` request is the
     * agent asking for input, which this surface has no card for.
     */
    async "input.requested"(event, channel) {
      const discussionID = discussionOf(channel);

      for (const request of event.requests) {
        if (request.kind !== "tool-approval") continue;

        const toolCallID = request.action.callId;
        gated.set(toolCallID, request.requestId);

        await plain().upsertToolCall(discussionID, toolCallID, "PENDING", describe(request.action));
        await plain().requestApproval(discussionID, toolCallID, request.prompt);
      }
    },

    async "action.result"(event, channel) {
      const discussionID = discussionOf(channel);
      const callID = callIDOf(event.result);
      if (callID === undefined) return;

      // "rejected" means a denied approval. Plain already failed that call with the reviewer note
      // as its error, so writing an ERROR would be a second worse explanation and Plain NOOPs it.
      if (event.status === "rejected") return;

      const failed = event.status === "failed";
      await plain().upsertToolCall(
        discussionID,
        callID,
        failed ? "ERROR" : "SUCCESS",
        describeResult(event.result),
        failed ? (errorTextOf(event.error) ?? "the tool call failed") : undefined,
      );
    },

    async "message.completed"(event, channel) {
      const markdown = textOf(event.message);
      if (markdown === "") return;
      await plain().sendMessage(discussionOf(channel), markdown);
    },

    // Settles last, and only after the reply is posted: the reply is what marks the discussion
    // unread, so settling first would claim the agent had finished before the answer existed.
    async "session.waiting"(_event, channel) {
      await plain().setAgentStatus(discussionOf(channel), "IDLE");
    },

    async "turn.failed"(event, channel) {
      await reportFailure(discussionOf(channel), messageOf(event));
    },

    // Runs outside session context, so it gets no ctx and the address comes off the channel.
    async "session.failed"(event, channel) {
      await reportFailure(discussionOf(channel), messageOf(event));
    },
  },
});

// The address a channel operation was bound to is the Plain discussion id, because that is the
// continuation token this channel mints.
function discussionOf(channel: { continuation?: { token: string } }): string {
  const token = channel.continuation?.token;
  if (token === undefined || token === "") throw new Error("no Plain discussion on this session");
  return token;
}

function describe(action: { toolName: string; input: unknown }): string {
  const input = JSON.stringify(action.input);
  return truncate(`${action.toolName}(${input})`, 2000);
}

function describeResult(result: unknown): string {
  return truncate(`returned ${JSON.stringify(result)}`, 2000);
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

function textOf(message: unknown): string {
  if (typeof message === "string") return message.trim();
  if (message !== null && typeof message === "object" && "text" in message) {
    const text = (message as { text?: unknown }).text;
    if (typeof text === "string") return text.trim();
  }
  return "";
}

function messageOf(event: unknown): string {
  if (event !== null && typeof event === "object" && "error" in event) {
    const text = errorTextOf((event as { error?: unknown }).error);
    if (text !== undefined) return text;
  }
  return "the agent run failed";
}

function errorTextOf(error: unknown): string | undefined {
  if (typeof error === "string") return error;
  if (error !== null && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return undefined;
}

function callIDOf(result: unknown): string | undefined {
  if (result !== null && typeof result === "object" && "callId" in result) {
    const callID = (result as { callId?: unknown }).callId;
    if (typeof callID === "string") return callID;
  }
  return undefined;
}

/** The failure is posted before the status settles, so the user reads what went wrong. */
async function reportFailure(discussionID: string, message: string): Promise<void> {
  await plain().sendMessage(discussionID, `The agent could not finish this turn.\n\n> ${message}`);
  await plain().setAgentStatus(discussionID, "IDLE");
}
