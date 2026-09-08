import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { runTurn } from "./core.ts";
import type { Plain } from "./plain.ts";

/**
 * The internal-agent surface: an agent in a Sidekick discussion, answering your own team.
 *
 * The gate here is a real approval card, because discussions have one: report the call, ask, and
 * wait for a person. Compare `support.ts`, where the same idea is expressed by drafting a reply
 * instead of sending it, since threads have no card.
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
    // Settles last on purpose: posting the reply is what marks the discussion unread, so settling
    // first would claim the agent had finished before its answer existed.
    await plain.setDiscussionAgentStatus(context.discussionID, "IDLE");
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
 * Polling keeps the flow readable in one function. The webhooks
 * `discussion.tool_call_approval_requested` and `discussion.tool_call_approval_resolved` are the
 * better choice once a turn can outlive the process; `example-eve-agent` uses those.
 */
async function waitForApproval(
  plain: Plain,
  discussionID: string,
  toolCallID: string,
  text: string,
): Promise<Decision> {
  await plain.requestApproval(discussionID, toolCallID, `The agent wants to ${text}.`);

  const deadline = Date.now() + APPROVAL_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const outcome = await plain.approvalOutcome(discussionID, toolCallID);
    if (outcome?.decision === "APPROVED") return { denied: false, note: null };
    if (outcome?.decision === "DENIED") return { denied: true, note: outcome.reviewerNote };
    await sleep(APPROVAL_POLL_MS);
  }

  // Nobody decided. Reported as an error so the timeline does not keep a call PENDING forever,
  // which would leave the discussion looking like it is still waiting on the agent.
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
