import { truncate } from "./config.ts";
import type { ApprovalOutcome, PlainClient } from "./plain.ts";

/** How long to wait for a human before giving up on a card and leaving it open. */
const WAIT_TIMEOUT_MS = 15 * 60_000;
/** Polling, because there is no webhook for an approval being resolved yet. */
const POLL_INTERVAL_MS = 3_000;

export type GatedAction = {
  /** Unique within the discussion. A second attempt at the same action needs a new one. */
  toolCallID: string;
  /** What the reviewer reads as the card's heading. Carries the action and a preview. */
  text: string;
  /** Why the agent believes this is ready to run, in its own words. */
  justification: string;
};

/**
 * Reports the action as a PENDING call, asks for approval, and waits for a human.
 *
 * The agent status is deliberately left alone here. Plain moves the discussion to its
 * approval-pending state on `requestDiscussionToolCallApproval` and refuses IDLE or IN_PROGRESS
 * while a card is open, so setting either would fail the mutation and lie about the state.
 */
export async function askForApproval(
  client: PlainClient,
  discussionID: string,
  action: GatedAction,
  log: (line: string) => void,
): Promise<ApprovalOutcome | "TIMED_OUT"> {
  await client.upsertToolCall(discussionID, action.toolCallID, "PENDING", action.text);
  await client.requestApproval(discussionID, action.toolCallID, action.justification);
  log(`waiting for a human on ${action.toolCallID}`);

  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    // A read failure is transient far more often than it is fatal, and giving up here would leave
    // the card open with nobody watching it.
    const outcome = await client.approvalOutcome(discussionID, action.toolCallID).catch(() => null);
    if (outcome) return outcome;
  }
  return "TIMED_OUT";
}

/**
 * Closes an abandoned card. Without this the card stays PENDING and still actionable, so a reviewer
 * arriving after the timeout can approve a draft that will never be sent and be told nothing.
 */
export async function reportAbandoned(
  client: PlainClient,
  discussionID: string,
  action: GatedAction,
): Promise<void> {
  await client.upsertToolCall(
    discussionID,
    action.toolCallID,
    "ERROR",
    action.text,
    `no decision within ${Math.round(WAIT_TIMEOUT_MS / 60_000)} minutes, so this draft was discarded`,
  );
}

/** Reports how the approved call actually went, so the timeline entry stops saying PENDING. */
export async function reportOutcome(
  client: PlainClient,
  discussionID: string,
  action: GatedAction,
  err: unknown,
): Promise<void> {
  if (err === undefined) {
    await client.upsertToolCall(discussionID, action.toolCallID, "SUCCESS", action.text);
    return;
  }
  const reason = err instanceof Error ? err.message : String(err);
  await client.upsertToolCall(discussionID, action.toolCallID, "ERROR", action.text, reason);
}

/**
 * The card's heading. A reviewer should be able to decide from it alone, so it names the action and
 * previews the content rather than saying "send a message".
 */
export function describeReply(draft: string): string {
  return `Reply to the customer: ${truncate(oneLine(stripMarkdown(draft)), 200)}`;
}

/**
 * The card heading is plain text, so markdown syntax shows up literally there while the posted reply
 * renders it. Seeing `**ready to send**` on the card reads as a bug even though it is the real draft.
 *
 * Blockquote markers are deliberately NOT stripped: a line-start `>` is ambiguous between a quote and
 * a comparison, and eating it turns "> 100 duplicates" into "100 duplicates". A stray `>` reads fine
 * anyway, unlike `**`, so the rule cost more than it bought.
 */
export function stripMarkdown(s: string): string {
  return s
    .replace(/```[\s\S]*?```/g, " code block ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/(\*\*\*|___)(.+?)\1/g, "$2")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(?<![*\w])\*(?!\s)([^*]+?)(?<!\s)\*(?![*\w])/g, "$1")
    .replace(/(?<![_\w])_(?!\s)([^_]+?)(?<!\s)_(?![_\w])/g, "$1");
}

export function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
