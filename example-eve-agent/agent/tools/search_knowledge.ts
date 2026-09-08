import { defineTool } from "eve/tools";
import { z } from "zod";
import { plain } from "#lib/client.ts";

const RESULTS = 4;

/**
 * The tool the agent leans on for every answer.
 *
 * Plain does the retrieval over the workspace help center and any indexed document, so this
 * example ships no vector store and no embedding step of its own.
 */
export default defineTool({
  description:
    "Search the workspace help center and indexed documents for an answer. Call this before " +
    "replying, and search again with different wording if the first results miss.",
  inputSchema: z.object({
    query: z.string().min(1).describe("What the customer wants to know, in your own words."),
  }),
  async *execute({ query }) {
    // The first yield reaches the channel as an `action.partial`, so Plain's timeline shows the
    // search running rather than jumping from PENDING straight to a result.
    yield { searching: query, found: null, results: [] };

    const hits = await plain().searchKnowledge(query, RESULTS);

    // Said plainly, because a model reads an empty array as a broken tool and retries it.
    if (hits.length === 0) {
      yield {
        searching: null,
        found: 0,
        results: [],
        note: "Nothing matched. Try different wording once.",
      };
      return;
    }

    yield { searching: null, found: hits.length, results: hits };
  },
});
