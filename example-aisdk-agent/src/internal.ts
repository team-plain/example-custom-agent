import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { runTurn } from "./core.ts";
import type { Plain } from "./plain.ts";

/**
 * The internal-agent surface: an agent in a Sidekick discussion, answering your own team.
 *
 * Discussions have an approval card, so the gate is the real thing. Compare `support.ts`, where
 * the same idea is a drafted reply instead.
 */
export type InternalContext = {
  discussionID: string;
  /** When true a consequential tool call needs a person to approve it first. On by default. */
  gated: boolean;
};

export type InternalOutcome = { answered: boolean; steps: number };

// How long to wait for a person to click Approve, and how often to look.
const APPROVAL_TIMEOUT_MS = 300_000;
const APPROVAL_POLL_MS = 2_000;

/**
 * Discussions left with an approval card open.
 *
 * Only `resolveDiscussionApproval` clears TOOL_CALL_APPROVAL_PENDING, and a machine user is not
 * allowed to call it, so an unanswered card cannot be closed by this agent at all.
 */
const approvalOpen = new Set<string>();

export async function handleDiscussion(
  plain: Plain,
  system: string,
  prompt: string,
  context: InternalContext,
): Promise<InternalOutcome> {
  await plain.setDiscussionAgentStatus(context.discussionID, "IN_PROGRESS");

  try {
    const turn = await runTurn({
      system,
      prompt,
      tools: discussionTools(plain, context),
    });

    const answer = turn.text === "" ? "I could not produce an answer for this." : turn.text;
    await plain.sendDiscussionMessage(context.discussionID, answer);
    return { answered: true, steps: turn.steps };
  } catch (err) {
    // The failure is posted before the status settles, so the person reads what went wrong rather
    // than watching a discussion go quiet.
    const reason = err instanceof Error ? err.message : String(err);
    await plain.sendDiscussionMessage(
      context.discussionID,
      `I could not finish this turn.\n\n> ${reason}`,
    );
    return { answered: false, steps: 0 };
  } finally {
    // Settles last, because posting the reply is what marks the discussion unread. Skipped while a
    // card is open: Plain refuses a status then, and an unchecked write crashes the whole turn.
    if (!approvalOpen.has(context.discussionID)) {
      await plain.setDiscussionAgentStatus(context.discussionID, "IDLE");
    }
    approvalOpen.delete(context.discussionID);
  }
}

function discussionTools(plain: Plain, context: InternalContext): ToolSet {
  return {
    page_oncall: tool({
      description:
        "Page the on-call engineer about an urgent customer problem. Only when something is " +
        "actively broken for a customer and cannot wait for support hours.",
      inputSchema: z.object({
        summary: z.string().min(1).describe("One line the on-call engineer reads first."),
        severity: z.enum(["high", "critical"]),
      }),
      async execute({ summary, severity }) {
        // A caller-chosen id, unique in the discussion, because the approval names the call by it.
        const toolCallID = `page-oncall-${Date.now()}`;
        const text = `page the on-call engineer (${severity}): ${summary}`;

        await plain.upsertToolCall(context.discussionID, toolCallID, "PENDING", text);

        if (context.gated) {
          const decision = await waitForApproval(plain, context.discussionID, toolCallID, text);
          // On DENIED Plain has already failed the call with the reviewer note as its error, so
          // writing an ERROR here would replace a person's reason with a worse one.
          if (decision.denied) return { paged: false, denied: true, note: decision.note };
        }

        // Mocked: this example ships no pager credential. The gate above is the part to copy.
        await plain.upsertToolCall(
          context.discussionID,
          toolCallID,
          "SUCCESS",
          `${text} (mocked, no pager configured)`,
        );
        return { paged: false, mocked: true, severity, summary };
      },
    }),
  };
}

type Decision = { denied: boolean; note: string | null };

/**
 * Waits for a person to decide, by polling.
 *
 * Polling keeps the flow in one function. The approval webhooks are the better choice once a turn
 * can outlive the process, and `example-eve-agent` uses those.
 */
async function waitForApproval(
  plain: Plain,
  discussionID: string,
  toolCallID: string,
  text: string,
): Promise<Decision> {
  // No trailing period: `text` already ends with the model's own summary, which usually has one.
  await plain.requestApproval(discussionID, toolCallID, `The agent wants to ${text}`);
  approvalOpen.add(discussionID);

  const deadline = Date.now() + APPROVAL_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const outcome = await plain.approvalOutcome(discussionID, toolCallID);
    if (outcome?.decision === "APPROVED") {
      approvalOpen.delete(discussionID);
      return { denied: false, note: null };
    }
    if (outcome?.decision === "DENIED") {
      approvalOpen.delete(discussionID);
      return { denied: true, note: outcome.reviewerNote };
    }
    await sleep(APPROVAL_POLL_MS);
  }

  // Nobody decided, so the call is failed to stop it reading as still running. The card stays
  // open: only a person can close it, so `approvalOpen` keeps the status write from being tried.
  await plain.upsertToolCall(
    discussionID,
    toolCallID,
    "ERROR",
    text,
    "the agent stopped waiting for an approval",
  );
  return { denied: true, note: null };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
