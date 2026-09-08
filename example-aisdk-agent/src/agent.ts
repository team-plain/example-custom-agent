import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { runTurn } from "./core.ts";
import { truncate } from "./config.ts";
import type { Plain } from "./plain.ts";

/**
 * One agent turn in a Sidekick discussion opened on a customer thread.
 *
 * The agent reads the thread, searches the workspace knowledge, and proposes a reply. Every call
 * lands on the discussion timeline as it happens, so the team watches the work rather than a
 * spinner.
 */
export type TurnContext = {
  discussionID: string;
  /** The thread the discussion was opened on, or null when it was opened on nothing. */
  threadID: string | null;
};

export type TurnOutcome = { answered: boolean; steps: number };

// How long to wait for a person to click Approve, and how often to look.
const APPROVAL_TIMEOUT_MS = 300_000;
const APPROVAL_POLL_MS = 2_000;

const KNOWLEDGE_RESULTS = 4;

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
  context: TurnContext,
): Promise<TurnOutcome> {
  await plain.setDiscussionAgentStatus(context.discussionID, "IN_PROGRESS");

  try {
    const turn = await runTurn({
      system,
      prompt: promptWithContext(prompt, context),
      tools: agentTools(plain, context),
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

// Says up front whether there is a customer thread, so the model does not reach for a tool that
// cannot work and then apologise for it.
export function promptWithContext(prompt: string, context: TurnContext): string {
  const where =
    context.threadID === null
      ? "This discussion is not attached to a customer thread, so you cannot read one or reply."
      : `This discussion is attached to customer thread ${context.threadID}.`;
  return `${where}\n\n${prompt}`;
}

function agentTools(plain: Plain, context: TurnContext): ToolSet {
  return {
    read_customer_thread: tool({
      description:
        "Read the customer conversation this discussion was opened on. Call this first, so the " +
        "answer addresses what the customer actually asked.",
      inputSchema: z.object({}),
      async execute() {
        if (context.threadID === null) {
          return { read: false, reason: "This discussion has no customer thread." };
        }

        const threadID = context.threadID;
        return report(plain, context, "read the customer thread", async () => {
          const text = await plain.threadAsText(threadID);
          return { read: true, conversation: text };
        });
      },
    }),

    search_knowledge: tool({
      description:
        "Search the workspace help center and indexed documents for an answer. Call this before " +
        "replying, and search again with different wording if the first results miss.",
      inputSchema: z.object({
        query: z.string().min(1).describe("What the customer wants to know, in your own words."),
      }),
      async execute({ query }) {
        return report(plain, context, `searched the knowledge base for "${query}"`, async () => {
          const hits = await plain.searchKnowledge(query, KNOWLEDGE_RESULTS);
          // Said plainly, because a model reads an empty array as a broken tool and retries it.
          if (hits.length === 0) {
            return { found: 0, results: [], note: "Nothing matched. Try different wording once." };
          }
          return { found: hits.length, results: hits };
        });
      },
    }),

    reply_to_customer: tool({
      description:
        "Send a reply to the customer on their thread. A person must approve it first. Only call " +
        "this once you have grounded the answer in the knowledge base.",
      inputSchema: z.object({
        message: z.string().min(1).describe("The reply, in markdown, addressed to the customer."),
      }),
      async execute({ message }) {
        if (context.threadID === null) {
          return { sent: false, reason: "This discussion has no customer thread to reply on." };
        }
        const threadID = context.threadID;

        const toolCallID = `reply-to-customer-${Date.now()}`;
        const text = `Reply to the customer: ${truncate(oneLine(message), 200)}`;
        await plain.upsertToolCall(context.discussionID, toolCallID, "PENDING", text);

        // Always gated, with no switch to turn it off. Everything else here is a read; this is the
        // one call a customer sees, so it is the one call a person decides.
        const decision = await waitForApproval(plain, context.discussionID, toolCallID, text, {
          justification: `The agent wants to send this reply to the customer:\n\n${message}`,
        });
        if (decision.denied) {
          return {
            sent: false,
            denied: true,
            note: decision.note,
            // Spelled out because a model reads a bare false as a system fault and retries.
            guidance: "A person declined this reply. Do not send it again unchanged.",
          };
        }

        try {
          await plain.replyToThread(threadID, message);
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          await plain.upsertToolCall(context.discussionID, toolCallID, "ERROR", text, reason);
          return { sent: false, error: reason };
        }

        await plain.upsertToolCall(context.discussionID, toolCallID, "SUCCESS", text);
        return { sent: true, threadID };
      },
    }),
  };
}

/**
 * Runs one read and reports it on the discussion timeline, PENDING before and settled after.
 *
 * The point of the example: the team sees each search as it happens instead of one silent pause.
 */
async function report<T>(
  plain: Plain,
  context: TurnContext,
  text: string,
  work: () => Promise<T>,
): Promise<T | { failed: true; error: string }> {
  const toolCallID = `${slug(text)}-${Date.now()}`;
  await plain.upsertToolCall(context.discussionID, toolCallID, "PENDING", text);

  try {
    const result = await work();
    await plain.upsertToolCall(context.discussionID, toolCallID, "SUCCESS", text);
    return result;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await plain.upsertToolCall(context.discussionID, toolCallID, "ERROR", text, reason);
    return { failed: true, error: reason };
  }
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
  card: { justification: string },
): Promise<Decision> {
  await plain.requestApproval(discussionID, toolCallID, card.justification);
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

export function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

// A readable toolCallId prefix. Plain only needs uniqueness, but a person reads these ids.
function slug(text: string): string {
  return (
    oneLine(text)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40) || "call"
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
