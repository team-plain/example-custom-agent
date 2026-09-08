import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";

/**
 * A deliberately consequential action, so the approval gate has something real to guard.
 *
 * The paging itself is mocked: this example ships no pager credential. What is not mocked is the
 * gate, which is the part worth copying.
 */
export default defineTool({
  description:
    "Page the on-call engineer about an urgent customer problem. Use only when the issue is " +
    "actively breaking something for a customer and cannot wait for normal support hours.",
  inputSchema: z.object({
    summary: z.string().min(1).describe("One line the on-call engineer reads first."),
    severity: z.enum(["high", "critical"]),
  }),
  // always(), not once(): every page is its own decision, and a session that paged once has not
  // earned the right to page again unasked.
  approval: always(),
  async execute({ summary, severity }) {
    return { paged: false, mocked: true, severity, summary };
  },
});
