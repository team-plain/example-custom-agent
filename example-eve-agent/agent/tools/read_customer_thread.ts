import { defineTool } from "eve/tools";
import { z } from "zod";
import { mayReplyTo, plain, trustRequestedThread } from "#lib/client.ts";

export default defineTool({
  description:
    "Read a customer conversation. Call this before answering, so the reply addresses what the " +
    "customer actually asked.",
  inputSchema: z.object({
    threadId: z
      .string()
      .min(1)
      .describe("This discussion's thread, or one from list_thread_queue or search_threads."),
  }),
  async execute({ threadId }) {
    // The id came through the prompt, so it is model output rather than trusted input. The pin
    // also refuses a thread other than the one the colleague named.
    // Only bites outside a real delivery, so `eve invoke` can be handed a thread id directly.
    trustRequestedThread(threadId);
    const allowed = mayReplyTo(threadId);
    if (!allowed.ok) return { ok: false as const, reason: allowed.reason };

    const conversation = await plain().threadAsText(threadId);
    // The link travels with the content, so naming this thread later needs no invention.
    return { read: true, threadId, url: await plain().threadURL(threadId), conversation };
  },
});
