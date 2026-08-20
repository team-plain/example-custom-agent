import { createHmac, timingSafeEqual } from "node:crypto";
import { DISCUSSION_MESSAGE_CREATED_EVENT } from "./config.ts";
import type { MachineUser } from "./plain.ts";

export const SIGNATURE_HEADER = "Plain-Request-Signature";

export type Actor = {
  actorType: "user" | "machineUser" | "customer" | "system" | string;
  userId?: string;
  machineUserId?: string;
  customerId?: string;
  system?: string;
};

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

export type WebhookEnvelope = {
  id: string;
  type: string;
  timestamp: string;
  workspaceId: string;
  webhookMetadata: { webhookTargetVersion: string };
  payload: unknown;
};

export type DiscussionMessageCreatedPayload = {
  eventType: string;
  discussion: {
    id: string;
    type: string;
    agent: Pick<MachineUser, "id"> | null;
    status: string;
    threadId: string | null;
  };
  message: {
    id: string;
    type: string;
    markdown: string;
    createdBy: Actor;
    createdAt: string;
  };
};

/**
 * Recomputes the hex SHA-256 HMAC over the raw body, which is how Plain signs every outbound
 * webhook. It must run on the untouched bytes: re-encoding the JSON first breaks it.
 */
export function verifySignature(rawBody: string, signature: string, secret: string): void {
  if (signature === "") {
    throw new Error(`request carried no ${SIGNATURE_HEADER} header`);
  }
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const given = Buffer.from(signature);
  const want = Buffer.from(expected);
  if (given.length !== want.length || !timingSafeEqual(given, want)) {
    throw new Error("signature does not match the workspace HMAC secret");
  }
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

  if (payload.eventType !== DISCUSSION_MESSAGE_CREATED_EVENT) {
    return skip(`not a discussion message event: ${payload.eventType}`);
  }
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
