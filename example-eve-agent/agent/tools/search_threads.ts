import { defineTool } from "eve/tools";
import { z } from "zod";
import { plain, rememberThread } from "#lib/client.ts";

const RESULTS = 10;

export default defineTool({
  description:
    "Search threads by what they are about, to find the one a question refers to. Returns thread " +
    "ids you can then read or reply on.",
  inputSchema: z.object({
    query: z.string().min(1).describe("Words that would appear in the thread."),
  }),
  async *execute({ query }) {
    yield { searching: query, found: null, threads: [] };

    const threads = await plain().searchThreads(query, RESULTS);
    for (const thread of threads) rememberThread(thread.id);

    if (threads.length === 0) {
      yield {
        searching: null,
        found: 0,
        threads: [],
        note: "No thread matched. Try different wording.",
      };
      return;
    }

    yield { searching: null, found: threads.length, threads };
  },
});
