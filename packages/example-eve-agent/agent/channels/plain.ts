import { defineChannel, POST } from "eve/channels";
import { parseInputResponses } from "eve/client";
import { verifyPlainWebhook } from "@team-plain/webhooks";
import { Plain } from "#lib/plain.ts";
import {
  PendingApprovals,
  SeenDeliveries,
  approvalKey,
  optionIDFor,
  promptFrom,
  shouldAnswer,
  type ApprovalResolved,
  type MessageCreated,
} from "#lib/decide.ts";

// Same path example-coding-agent serves, so one webhook target works for either.
const WEBHOOK_PATH = "/plain/webhook";

const MESSAGE_CREATED = "discussion.message_created";
const APPROVAL_RESOLVED = "discussion.tool_call_approval_resolved";

// Deliveries already handled, so a Plain retry does not answer twice. Module-level because a first
// delivery has no session yet, so per-session channel state cannot hold it.
const seen = new SeenDeliveries();

/**
 * Approval key to eve requestId, for calls parked on a person.
 *
 * Module-level for the same reason as `seen`: the approval webhook arrives outside any session.
 */
const gated = new Map<string, string>();

const awaitingApproval = new PendingApprovals();

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

// Cleared on rejection: caching the promise would let one failed identity query poison every
// later delivery until the process restarts.
function me(): Promise<string> {
  machineUserID ??= plain()
    .myMachineUserID()
    .catch((err: unknown) => {
      machineUserID = undefined;
      throw err;
    });
  return machineUserID;
}

type ChannelFrom = (address: string) => {
  send: (message: string, options: { auth: null }) => Promise<unknown>;
  respond: (responses: never, options: { auth: null }) => Promise<unknown>;
};

export default defineChannel({
  routes: [
    POST(WEBHOOK_PATH, async (request, { from, waitUntil }) => {
      // verifyPlainWebhook needs the raw body: re-serialising changes the bytes it signed over.
      const raw = await request.text();
      const verified = verifyPlainWebhook(
        raw,
        request.headers.get("plain-request-signature") ?? "",
        (process.env.PLAIN_WEBHOOK_SECRET ?? "").trim(),
      );
      if (verified.error) return new Response(verified.error.message, { status: 400 });

      const payload = verified.data.payload;

      if (payload.eventType === APPROVAL_RESOLVED) {
        await resumeApproval(payload, from as unknown as ChannelFrom);
        return new Response(null, { status: 200 });
      }

      if (payload.eventType === MESSAGE_CREATED) {
        await startTurn(payload, from as unknown as ChannelFrom, waitUntil);
      }

      return new Response(null, { status: 200 });
    }),
  ],

  events: {
    async "turn.started"(_event, channel) {
      await plain().setAgentStatus(discussionOf(channel), "IN_PROGRESS");
    },

    // One line on the Plain timeline per call, before it runs. Correlated by callId because eve
    // warns that calls arrive incrementally rather than one event per step.
    async "actions.requested"(event, channel) {
      const discussionID = discussionOf(channel);
      for (const action of event.actions) {
        if (action.kind !== "tool-call") continue;
        await plain().upsertToolCall(discussionID, action.callId, "PENDING", describe(action));
      }
    },

    // The gate. eve parked the turn; Plain shows the card and owns the decision. Only
    // `tool-approval` becomes a card: a `question` or `session-limit` has no equivalent here.
    async "input.requested"(event, channel) {
      const discussionID = discussionOf(channel);

      for (const request of event.requests) {
        if (request.kind !== "tool-approval") continue;

        const toolCallID = request.action.callId;
        gated.set(approvalKey(discussionID, toolCallID), request.requestId);
        awaitingApproval.opened(discussionID);

        await plain().upsertToolCall(discussionID, toolCallID, "PENDING", describe(request.action));
        await plain().requestApproval(discussionID, toolCallID, justify(request));
      }
    },

    async "action.result"(event, channel) {
      const callID = callIDOf(event.result);
      if (callID === undefined) return;

      // "rejected" is a denied approval. Plain already failed that call with the reviewer note, so
      // an ERROR here would replace a person's reason with a worse one.
      if (event.status === "rejected") return;

      const failed = event.status === "failed";
      await plain().upsertToolCall(
        discussionOf(channel),
        callID,
        failed ? "ERROR" : "SUCCESS",
        describeResult(event.result),
        failed ? (errorTextOf(event.error) ?? "the tool call failed") : undefined,
      );
    },

    // Only terminal output reaches Plain. A message finishing on "tool-calls" is interim narration
    // before the tool runs, and posting it would read as the answer.
    async "message.completed"(event, channel) {
      if (finishReasonOf(event) === "tool-calls") return;
      const markdown = textOf(event.message);
      if (markdown === "") return;
      await plain().sendMessage(discussionOf(channel), markdown);
    },

    // eve emits this after `input.requested` while the card is still up, and Plain refuses IDLE
    // during a pending approval, so settling here would fail the whole turn.
    async "session.waiting"(_event, channel) {
      const discussionID = discussionOf(channel);
      if (!awaitingApproval.canSettleStatus(discussionID)) return;
      await plain().setAgentStatus(discussionID, "IDLE");
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

/**
 * Answers the parked turn with the human's decision.
 *
 * Plain owns the decision, eve owns the pause, and `requestId` joins them.
 */
async function resumeApproval(payload: ApprovalResolved, from: ChannelFrom): Promise<void> {
  const discussionID = payload.discussion.id;
  const key = approvalKey(discussionID, payload.toolCallId);
  const requestID = gated.get(key);
  if (requestID === undefined) return;

  // Undefined means Plain reported something that is not a decision, so the request stays parked
  // rather than being cancelled on a status this code does not understand.
  const optionID = optionIDFor(payload.status);
  if (optionID === undefined) {
    await plain().upsertToolCall(
      discussionID,
      payload.toolCallId,
      "ERROR",
      `unresolved approval for ${payload.toolCallId}`,
      `Plain reported approval status ${payload.status}, which this agent does not handle`,
    );
    return;
  }

  await from(discussionID).respond(
    parseInputResponses([{ requestId: requestID, optionId: optionID }]) as never,
    { auth: null },
  );

  // Only after respond succeeds. Deleting first loses the one mapping that can resume this turn,
  // and Plain's retry would then answer 200 while the turn stayed parked.
  gated.delete(key);
  awaitingApproval.settled(discussionID);
}

/** Starts or resumes the eve session for this discussion. */
async function startTurn(
  payload: MessageCreated,
  from: ChannelFrom,
  waitUntil: (work: Promise<unknown>) => void,
): Promise<void> {
  if (!shouldAnswer(payload, await me())) return;
  if (seen.check(payload.message.id)) return;

  const text = promptFrom(payload);
  if (text === "") return;

  // from(discussion.id) creates the session on the first message and resumes it on later ones,
  // which is the whole discussion-to-session mapping.
  waitUntil(from(payload.discussion.id).send(text, { auth: null }));
}

// The address a channel operation was bound to is the Plain discussion id, because that is the
// continuation token this channel mints.
function discussionOf(channel: { continuation?: { token: string } }): string {
  const token = channel.continuation?.token;
  if (token === undefined || token === "") throw new Error("no Plain discussion on this session");
  return token;
}

/**
 * What the reviewer reads under the card.
 *
 * eve's own prompt is generic ("Approve tool call: page_oncall"), so the arguments go in too:
 * nobody can approve a call whose inputs they cannot see.
 */
function justify(request: { prompt: string; action: { toolName: string; input: unknown } }): string {
  return truncate(`${request.prompt}\n\nArguments: ${JSON.stringify(request.action.input)}`, 4000);
}

function describe(action: { toolName: string; input: unknown }): string {
  return truncate(`${action.toolName}(${JSON.stringify(action.input)})`, 2000);
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

function finishReasonOf(event: unknown): string | undefined {
  if (event === null || typeof event !== "object") return undefined;
  if ("finishReason" in event) {
    const reason = (event as { finishReason?: unknown }).finishReason;
    if (typeof reason === "string") return reason;
  }
  if ("message" in event) return finishReasonOf((event as { message?: unknown }).message);
  return undefined;
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

  // Only a person can close an open card, so the status write is skipped rather than attempted:
  // Plain refuses it, and an unchecked failure here would bury the report just posted.
  if (awaitingApproval.canSettleStatus(discussionID)) {
    await plain().setAgentStatus(discussionID, "IDLE");
  }
  awaitingApproval.settled(discussionID);
}
