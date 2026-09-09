import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";
import { mayReplyTo, plain } from "#lib/client.ts";

/**
 * The one call a customer sees, so the one call a person decides.
 *
 * `always()`, not `once()`: every reply is its own decision, and a session that sent one has not
 * earned the right to send the next unasked. eve parks the turn until Plain resolves the card, so
 * this body runs only after a person approved it.
 */
export default defineTool({
  description:
    "Send a reply to the customer on their thread. A person must approve it first. Only call this " +
    "once you have grounded the answer in the knowledge base.",
  inputSchema: z.object({
    threadId: z.string().min(1).describe("The thread to reply on. Must be one you have seen."),
    message: z.string().min(1).describe("The reply, in markdown, addressed to the customer."),
  }),
  approval: always(),
  async execute({ threadId, message }) {
    const allowed = mayReplyTo(threadId);
    if (!allowed.ok) return { ok: false as const, reason: allowed.reason };

    await plain().replyToThread(threadId, message);
    const target = await plain().threadTarget(threadId);
    // The link comes back so the model can name the thread without building a URL.
    return {
      sent: true,
      threadId,
      url: target.url,
      customerName: target.customerName,
      title: target.title,
    };
  },
});
