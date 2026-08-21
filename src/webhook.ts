import {
  verifyPlainWebhook,
  type Actor,
  type DiscussionMessageCreatedPublicEventPayload,
  type WebhooksSchemaDefinition,
} from "@team-plain/webhooks";
import { DISCUSSION_MESSAGE_CREATED_EVENT } from "./config.ts";

export const SIGNATURE_HEADER = "Plain-Request-Signature";

export type Envelope = WebhooksSchemaDefinition;
export type DiscussionMessageCreatedPayload = DiscussionMessageCreatedPublicEventPayload;

export function describeActor(actor: Actor): string {
  switch (actor.actorType) {
    case "user":
      return `a Plain user (${actor.userId})`;
    case "machineUser":
      return `a machine user (${actor.machineUserId})`;
    case "customer":
      return `a customer (${actor.customerId})`;
    case "system":
      return `Plain itself (${actor.system})`;
    default:
      return "an unknown actor";
  }
}

/**
 * Verifies the HMAC, validates the body against the schema for the webhook version the installed
 * SDK was built from, and rejects a delivery outside the replay window. A version mismatch surfaces
 * here, which is the only place that tells you the webhook target and the SDK have drifted apart.
 */
export function verify(rawBody: string, signature: string, secret: string): Envelope {
  const result = verifyPlainWebhook(rawBody, signature, secret);
  if (result.error) throw result.error;
  return result.data;
}

/** Narrows a validated envelope to the one event this agent answers. */
export function discussionMessage(envelope: Envelope): DiscussionMessageCreatedPayload | null {
  if (envelope.payload.eventType !== DISCUSSION_MESSAGE_CREATED_EVENT) return null;
  return envelope.payload;
}

/**
 * Decides whether this delivery is a turn the agent owes an answer to. Answering anything else
 * either loops (its own messages come back as webhooks) or steps on another agent's discussion.
 */
export function classify(
  payload: DiscussionMessageCreatedPayload,
  myMachineUserID: string,
): { answer: true } | { answer: false; reason: string } {
  const skip = (reason: string) => ({ answer: false as const, reason });

  if (payload.discussion.type !== "AGENT_SESSION") {
    return skip(`discussion is a ${payload.discussion.type} channel, not an agent session`);
  }
  if (!payload.discussion.agent) {
    return skip("discussion is Plain's own Sidekick, not a custom agent");
  }
  if (payload.discussion.agent.id !== myMachineUserID) {
    return skip(`discussion belongs to another agent (${payload.discussion.agent.id})`);
  }
  // On an agent session the agent's own output is INBOUND and a person's turn is OUTBOUND. Getting
  // this backwards makes the agent answer itself forever.
  if (payload.message.type !== "OUTBOUND") {
    return skip("message is the agent's own output, not a human turn");
  }
  if (
    payload.message.createdBy.actorType === "machineUser" &&
    payload.message.createdBy.machineUserId === myMachineUserID
  ) {
    return skip("message was written by this agent");
  }
  if (payload.discussion.status === "RESOLVED") {
    return skip("discussion is already resolved");
  }
  return { answer: true };
}
