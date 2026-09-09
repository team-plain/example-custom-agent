import { defineTool } from "eve/tools";
import { z } from "zod";
import { plain, rememberThread } from "#lib/client.ts";

const RESULTS = 10;

/**
 * What makes a threadless Sidekick session useful.
 *
 * Every id this returns becomes reachable, so the agent can then read or reply on a thread nobody
 * handed it. That widening is the point, and the approval card is what keeps it safe.
 */
export default defineTool({
  description:
    "List the support queue. Use this when the discussion is not attached to a thread, or to see " +
    "what else is waiting.",
  inputSchema: z.object({
    status: z
      .enum(["TODO", "SNOOZED", "DONE"])
      .default("TODO")
      .describe("TODO is the queue of threads needing attention."),
  }),
  async *execute({ status }) {
    yield { listing: status, found: null, threads: [] };

    const threads = await plain().listThreadQueue(status, RESULTS);
    for (const thread of threads) rememberThread(thread.id);

    yield { listing: null, found: threads.length, threads };
  },
});
