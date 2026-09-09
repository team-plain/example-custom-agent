import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { runTurn } from "./core.ts";
import { truncate } from "./config.ts";
import type { Plain, ThreadStatus } from "./plain.ts";

/**
 * One agent turn in a Sidekick discussion.
 *
 * The discussion may be attached to a customer thread or to nothing at all. Either way the agent
 * can search the queue, so a session opened on nothing is still useful. Every call lands on the
 * discussion timeline as it happens, so the team watches the work rather than a spinner.
 */
export type TurnContext = {
  discussionID: string;
  /** The thread the discussion was opened on, or null when it was opened on nothing. */
  threadID: string | null;
  /**
   * That thread's link, resolved once per turn.
   *
   * Here because the model invented one otherwise. Replying to the discussion's own thread calls no
   * search tool, so it never saw a `url` field, and given only an id it produced
   * `app.nairi.ai/threads/...` and `example.com`. A model with no link to hand will make one up.
   */
  threadURL?: string | null;
};

export type TurnOutcome = { answered: boolean; steps: number };

// How long to wait for a person to click Approve, and how often to look.
const APPROVAL_TIMEOUT_MS = 300_000;
const APPROVAL_POLL_MS = 2_000;

const KNOWLEDGE_RESULTS = 4;
const QUEUE_RESULTS = 10;

// Enough turns for a person to refer back to something without paying for the whole history.
const HISTORY_MESSAGES = 30;

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
  // Not fatal, and not outside the try. Plain refuses a status while an approval card is open, and
  // an unchecked throw here killed the whole turn before it started: no answer, no error the person
  // could see. The answer matters more than the spinner.
  await announce(plain, context.discussionID, "IN_PROGRESS");

  try {
    // Resolved once, so the preamble can carry a real link rather than a bare id.
    const withURL: TurnContext = {
      ...context,
      threadURL:
        context.threadURL ??
        (context.threadID === null ? null : await plain.threadURL(context.threadID)),
    };
    // Read before the turn, so the model sees what was said earlier in this discussion. The newest
    // message is already in there, carrying the where-am-I preamble on top.
    const history = await plain.discussionHistory(context.discussionID, HISTORY_MESSAGES);
    const turn = await runTurn({
      system,
      messages: conversation(history, prompt, withURL),
      tools: agentTools(plain, withURL, threadIDsIn(prompt)),
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
      await announce(plain, context.discussionID, "IDLE");
    }
    approvalOpen.delete(context.discussionID);
  }
}

/**
 * Reports the agent status, and carries on if Plain says no.
 *
 * The one refusal that matters: while an approval card is open Plain rejects any status with
 * "agentStatus cannot be reported while an approval is open on this discussion". That is expected
 * rather than broken, so it is logged and the turn continues.
 */
async function announce(
  plain: Plain,
  discussionID: string,
  status: "IN_PROGRESS" | "IDLE",
): Promise<void> {
  try {
    await plain.setDiscussionAgentStatus(discussionID, status);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.log(`   could not set ${status}: ${reason}`);
  }
}

/**
 * The conversation to send, ending with the message this turn answers.
 *
 * The history already contains that newest message, because Plain stored it before the webhook
 * arrived. It is dropped and re-added with the where-am-I preamble attached, so the preamble sits
 * on the turn being answered rather than on something said an hour ago.
 */
export function conversation(
  history: { role: "user" | "assistant"; content: string }[],
  prompt: string,
  context: TurnContext,
): { role: "user" | "assistant"; content: string }[] {
  // Only the last entry is dropped, and only when it is the message being answered. Filtering by
  // content would also delete an identical question asked earlier, losing real history.
  const earlier = [...history];
  if (earlier.at(-1)?.content.trim() === prompt.trim()) earlier.pop();
  return [...earlier, { role: "user", content: promptWithContext(prompt, context) }];
}

// Says up front where the agent is, so it does not reach for its own thread when there is none and
// then apologise for it.
export function promptWithContext(prompt: string, context: TurnContext): string {
  if (context.threadID === null) {
    return (
      "This discussion is not attached to a customer thread. Use list_thread_queue or " +
      `search_threads to find the thread you need.\n\n${prompt}`
    );
  }
  // The link goes in whenever there is one, so the model never has to construct a URL.
  const link = context.threadURL ? `\nIts link is ${context.threadURL}` : "";
  return `This discussion is attached to customer thread ${context.threadID}.${link}\n\n${prompt}`;
}

/**
 * Thread ids the colleague named in this request.
 *
 * Plain ids are prefixed and fixed-length, so this is exact rather than a guess.
 */
export function threadIDsIn(text: string): Set<string> {
  return new Set(text.match(/\bth_[0-9A-Za-z]{20,32}\b/g) ?? []);
}

/**
 * Whether a reply may target this thread.
 *
 * Two independent conditions. It has to be reachable, meaning a webhook or a search produced it.
 * And if the colleague named any thread in the request, it has to be one of those.
 *
 * The second half is not a nicety. Told to reply to an id it could not use, the model listed the
 * queue and replied to an unrelated customer instead, and no wording in the prompt reliably stopped
 * it. Being handed a bad id is not permission to pick a different customer.
 */
export function mayReplyTo(
  threadID: string,
  reachable: Set<string>,
  requested: Set<string>,
): { ok: true } | { ok: false; reason: string } {
  if (requested.size > 0 && !requested.has(threadID)) {
    return {
      ok: false,
      reason:
        `You were asked about ${[...requested].join(", ")}, so ${threadID} is not the thread to ` +
        "reply on. Tell your colleague the id you were given cannot be used and stop. Do not " +
        "reply to a different customer.",
    };
  }
  if (!reachable.has(threadID)) {
    return {
      ok: false,
      reason:
        `${threadID} is not a thread this turn has seen. Use list_thread_queue or search_threads ` +
        "first, then use an id from those results exactly as written.",
    };
  }
  return { ok: true };
}

/**
 * The threads this turn is allowed to touch.
 *
 * Seeded with the discussion's own thread and extended by whatever the queue and search return, so
 * an id the model invented, or lifted from text inside a customer's message, is refused. Per turn
 * rather than per process: what one discussion discovered is not another's to act on.
 */
function reachableThreads(context: TurnContext): Set<string> {
  const reachable = new Set<string>();
  if (context.threadID !== null) reachable.add(context.threadID);
  return reachable;
}

function agentTools(plain: Plain, context: TurnContext, requested: Set<string>): ToolSet {
  const reachable = reachableThreads(context);

  const refuse = (threadID: string) => ({
    ok: false as const,
    reason:
      `${threadID} is not a thread this turn has seen. Use list_thread_queue or search_threads ` +
      "first, then use an id from those results exactly as written.",
  });

  return {
    list_thread_queue: tool({
      description:
        "List the support queue. Use this when the discussion is not attached to a thread, or to " +
        "see what else is waiting.",
      inputSchema: z.object({
        status: z
          .enum(["TODO", "SNOOZED", "DONE"])
          .default("TODO")
          .describe("TODO is the queue of threads needing attention."),
      }),
      async execute({ status }) {
        return report(plain, context, `listed the ${status} queue`, async () => {
          const threads = await plain.listThreadQueue(status as ThreadStatus, QUEUE_RESULTS);
          for (const thread of threads) reachable.add(thread.id);
          return { found: threads.length, threads };
        });
      },
    }),

    search_threads: tool({
      description:
        "Search threads by what they are about, to find the one a question refers to. Returns " +
        "thread ids you can then read or reply on.",
      inputSchema: z.object({
        query: z.string().min(1).describe("Words that would appear in the thread."),
      }),
      async execute({ query }) {
        return report(plain, context, `searched threads for "${query}"`, async () => {
          const threads = await plain.searchThreads(query, QUEUE_RESULTS);
          for (const thread of threads) reachable.add(thread.id);
          if (threads.length === 0) {
            return { found: 0, threads: [], note: "No thread matched. Try different wording." };
          }
          return { found: threads.length, threads };
        });
      },
    }),

    read_customer_thread: tool({
      description:
        "Read a customer conversation. Call this before answering, so the reply addresses what " +
        "the customer actually asked.",
      inputSchema: z.object({
        threadId: z
          .string()
          .min(1)
          .describe("This discussion's thread, or one from list_thread_queue or search_threads."),
      }),
      async execute({ threadId }) {
        const allowed = mayReplyTo(threadId, reachable, requested);
        if (!allowed.ok) return { ok: false as const, reason: allowed.reason };

        return report(plain, context, `read thread ${threadId}`, async () => {
          const conversation = await plain.threadAsText(threadId);
          // The link travels with the content, so naming this thread later needs no invention.
          return { read: true, threadId, url: await plain.threadURL(threadId), conversation };
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
        threadId: z.string().min(1).describe("The thread to reply on. Must be one you have seen."),
        message: z.string().min(1).describe("The reply, in markdown, addressed to the customer."),
      }),
      async execute({ threadId, message }) {
        const allowed = mayReplyTo(threadId, reachable, requested);
        if (!allowed.ok) return { ok: false as const, reason: allowed.reason };

        // Resolved now rather than reused from a list, because the card has to name who receives
        // this. A reviewer approving a reply to the wrong customer is the failure to prevent.
        const target = await plain.threadTarget(threadId);

        const toolCallID = `reply-to-customer-${Date.now()}`;
        const text = `Reply to ${target.customerName} on "${target.title}": ${truncate(oneLine(message), 160)}`;
        await plain.upsertToolCall(context.discussionID, toolCallID, "PENDING", text);

        // Always gated, with no switch to turn it off. Everything else here is a read; this is the
        // one call a customer sees, so it is the one call a person decides.
        const decision = await waitForApproval(plain, context.discussionID, toolCallID, text, {
          justification: cardText(target, message),
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
          await plain.replyToThread(threadId, message);
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          await plain.upsertToolCall(context.discussionID, toolCallID, "ERROR", text, reason);
          return { sent: false, error: reason };
        }

        await plain.upsertToolCall(context.discussionID, toolCallID, "SUCCESS", text);
        // The link comes back so the model can name the thread without building a URL.
        return { sent: true, threadId, url: target.url };
      },
    }),
  };
}

/**
 * What the reviewer reads on the card.
 *
 * The target leads, because the agent can now reply to a thread it discovered rather than only the
 * one it was handed, and picking the wrong customer is the mistake worth catching here.
 */
export function cardText(
  target: { id: string; title: string; customerName: string; url?: string | null },
  message: string,
): string {
  // The link, not the id, when there is one: a reviewer who wants to check the thread should be one
  // click away rather than pasting an id into a search box.
  const where = target.url ?? target.id;
  return truncate(
    `Send this reply to ${target.customerName} on "${target.title}"\n${where}\n\n${message}`,
    4000,
  );
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
