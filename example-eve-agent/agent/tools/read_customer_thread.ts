import { defineTool } from "eve/tools";
import { z } from "zod";
import { isKnownThread, plain, refuseThread } from "#lib/client.ts";

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
    // The id came through the prompt, so it is model output rather than trusted input.
    if (!isKnownThread(threadId)) return refuseThread(threadId);

    const conversation = await plain().threadAsText(threadId);
    return { read: true, threadId, conversation };
  },
});
