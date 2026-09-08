import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { runTurn } from "./core.ts";
import type { Plain } from "./plain.ts";

/**
 * The support-agent surface: an agent on a customer thread.
 *
 * The gate here is not an approval card, because threads have none. It is the choice between
 * `replyToThread`, which reaches the customer, and `addGeneratedReply`, which drafts for a person
 * to review and send. Same principle as the discussion surface, different mechanism.
 */
export type SupportContext = {
  threadID: string;
  customerID: string;
  /** The customer message a suggested reply hangs off. Required by addGeneratedReply. */
  timelineEntryID: string | null;
  /** When true the agent drafts instead of sending. On by default. */
  gated: boolean;
};

export type SupportOutcome = {
  /** What the agent did, for the log and for the tests. */
  actions: string[];
  steps: number;
};

export async function handleThread(
  plain: Plain,
  system: string,
  context: SupportContext,
): Promise<SupportOutcome> {
  await plain.setThreadAgentStatus(context.threadID, "IN_PROGRESS");

  const actions: string[] = [];
  const conversation = await plain.threadAsText(context.threadID);

  try {
    const turn = await runTurn({
      system,
      prompt: `Here is the conversation so far.\n\n${conversation}`,
      tools: threadTools(plain, context, actions),
    });

    // Nothing was done and nothing was said: hand back rather than leave the thread looking
    // handled. A thread the agent silently dropped is worse than one it admits to.
    if (actions.length === 0) {
      await handOff(plain, context, "The agent took no action on this thread.");
      return { actions, steps: turn.steps };
    }

    return { actions, steps: turn.steps };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await handOff(plain, context, `The agent failed: ${reason}`);
    return { actions, steps: 0 };
  }
}

/**
 * Note, then HANDED_OFF, then unassign, then back to Todo.
 *
 * All four, in that order: the note is why a person is seeing this, and only HANDED_OFF puts the
 * thread back in a human queue. Stopping halfway leaves it invisible.
 */
async function handOff(
  plain: Plain,
  context: Pick<SupportContext, "threadID" | "customerID">,
  why: string,
): Promise<void> {
  await plain.createNote(context.threadID, context.customerID, why);
  await plain.setThreadAgentStatus(context.threadID, "HANDED_OFF");
  await plain.unassignThread(context.threadID);
  await plain.markThreadAsTodo(context.threadID);
}

function threadTools(plain: Plain, context: SupportContext, actions: string[]): ToolSet {
  return {
    reply_to_customer: tool({
      description:
        "Answer the customer. Use this when you are confident the answer is correct and complete.",
      inputSchema: z.object({
        markdown: z.string().min(1).describe("The reply, in Markdown."),
      }),
      async execute({ markdown }) {
        // The gate. Drafting is the default because the alternative is an unreviewed message to a
        // real customer, which is not a default an example should ship.
        if (context.gated) {
          if (context.timelineEntryID === null) {
            return { sent: false, reason: "no customer message to attach a suggestion to" };
          }
          await plain.suggestReply(context.threadID, context.timelineEntryID, markdown);
          actions.push("suggested a reply for review");
          return { sent: false, suggested: true };
        }

        await plain.replyToThread(context.threadID, markdown);
        actions.push("replied to the customer");
        await plain.setThreadAgentStatus(context.threadID, "HANDLED");
        return { sent: true };
      },
    }),

    add_internal_note: tool({
      description:
        "Leave a note on the thread for the next person. Never delivered to the customer. Use it " +
        "to record why you did or did not act.",
      inputSchema: z.object({ markdown: z.string().min(1) }),
      async execute({ markdown }) {
        await plain.createNote(context.threadID, context.customerID, markdown);
        actions.push("added an internal note");
        return { noted: true };
      },
    }),

    add_labels: tool({
      description: "Classify the thread by adding label types. Ids come from Settings, Labels.",
      inputSchema: z.object({ labelTypeIds: z.array(z.string().min(1)).min(1) }),
      async execute({ labelTypeIds }) {
        await plain.addLabels(context.threadID, labelTypeIds);
        actions.push(`added ${labelTypeIds.length} label(s)`);
        return { labelled: true };
      },
    }),

    hand_off_to_a_person: tool({
      description:
        "Give up and put the thread back in a human queue. Use this whenever you are unsure, " +
        "rather than guessing at a customer.",
      inputSchema: z.object({ why: z.string().min(1).describe("Why a person is needed.") }),
      async execute({ why }) {
        await handOff(plain, context, `Handing off: ${why}`);
        actions.push("handed off to a person");
        return { handedOff: true };
      },
    }),
  };
}
