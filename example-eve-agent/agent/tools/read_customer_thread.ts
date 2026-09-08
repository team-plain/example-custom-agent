import { defineTool } from "eve/tools";
import { z } from "zod";
import { isKnownThread, plain } from "#lib/client.ts";

export default defineTool({
  description:
    "Read the customer conversation this discussion was opened on. Call this first, so the answer " +
    "addresses what the customer actually asked.",
  inputSchema: z.object({
    threadId: z.string().min(1).describe("The customer thread id given to you in the message."),
  }),
  async execute({ threadId }) {
    // The id came through the prompt, so it is model output rather than trusted input.
    if (!isKnownThread(threadId)) {
      return { read: false, reason: `${threadId} is not the thread this discussion is on.` };
    }

    const conversation = await plain().threadAsText(threadId);
    return { read: true, threadId, conversation };
  },
});
