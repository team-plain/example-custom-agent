import { PlainClient as PlainSDK } from "@team-plain/graphql";

// A stuck call must not hold a turn open, and no call here is slow enough to want longer.
const REQUEST_TIMEOUT_MS = 30_000;

// One page of timeline entries. Large enough that most threads read in a single call.
const TIMELINE_PAGE = 50;

export type DiscussionAgentStatus = "IN_PROGRESS" | "IDLE";
export type ToolCallStatus = "PENDING" | "SUCCESS" | "ERROR";

export type ApprovalOutcome =
  | { decision: "APPROVED" }
  | { decision: "DENIED"; reviewerNote: string | null };

/** One hit from the workspace's indexed knowledge, already trimmed for a prompt. */
export type KnowledgeHit = {
  /** A help center article id, or a document URL if you widen the search. Cite it in the answer. */
  source: string;
  content: string;
};

/**
 * One earlier message in this discussion, as the model should see it.
 *
 * `user` is a person on your team, `assistant` is this agent. Plain calls those OUTBOUND and
 * INBOUND, which reads backwards until you remember it is describing the discussion, not the model.
 */
export type HistoryMessage = { role: "user" | "assistant"; content: string };

export type ThreadStatus = "TODO" | "SNOOZED" | "DONE";

/** Enough about a thread to list it. What the queue and search return cheaply. */
export type ThreadSummary = { id: string; title: string; status: string };

/**
 * One thread, plus who the customer is.
 *
 * Separate from the summary because the name costs a second query: the SDK returns `customer`
 * lazily on a thread and as an id alone on a search hit. It is only needed on an approval card,
 * where a reviewer has to see who receives the reply rather than just a thread id.
 */
export type ThreadTarget = ThreadSummary & { customerName: string };

type MutationError = { message: string; code: string } | null;

// Tool calls and approval cards live in the message list alongside real messages.
function isMachinery(typename: string | undefined): boolean {
  if (typename === undefined) return false;
  return typename.includes("ToolCall") || typename.includes("Approval");
}

/** Every Plain call this agent makes, on one client. */
export class Plain {
  private readonly sdk: PlainSDK;

  constructor(apiKey: string, apiURL: string) {
    this.sdk = new PlainSDK({ apiKey, apiUrl: apiURL });
  }

  async myMachineUserID(): Promise<string> {
    const me = await this.timeout(this.sdk.query.myMachineUser());
    return me.id;
  }

  // ---- reading ----

  /**
   * The whole thread as prompt-ready text.
   *
   * `llmText` is Plain's own rendering for a language model, so this does not reinvent it. Entry
   * types with nothing to render return null and are skipped.
   */
  async threadAsText(threadID: string): Promise<string> {
    const thread = await this.timeout(this.sdk.query.thread({ threadId: threadID }));
    if (thread === null) throw new Error(`thread ${threadID} not found`);

    const parts: string[] = [];
    let page = await this.timeout(thread.timelineEntries({ first: TIMELINE_PAGE }));

    for (;;) {
      for (const entry of page.nodes) {
        if (entry.llmText) parts.push(entry.llmText);
      }
      const next = await this.timeout(page.fetchNext());
      if (!next) break;
      page = next;
    }

    return parts.join("\n\n");
  }

  /**
   * Semantic search over the workspace help center. Plain does the retrieval, so this agent ships
   * no vector store and no embedding step of its own. Drop the `types` option to widen it.
   */
  async searchKnowledge(query: string, limit: number): Promise<KnowledgeHit[]> {
    const results = await this.timeout(
      this.sdk.query.searchKnowledgeSources({
        searchQuery: query,
        pageSize: limit,
        // Help center articles only. This workspace also has plain.com/docs indexed, and those
        // documents outranked the articles on any query sharing a word with them.
        options: { types: ["HELP_CENTER_ARTICLE"] },
      }),
    );

    return results.map((result) => ({
      source:
        result.__typename === "HelpCenterArticleSearchResult"
          ? result.helpCenterArticle.id
          : result.indexedDocument.url,
      content: result.content,
    }));
  }

  /**
   * The conversation so far, oldest first, so a turn is not a fresh start every time.
   *
   * Without this the agent answers each webhook with no idea a previous message existed: asked to
   * act on "the thread you just replied to" it has to guess, and guesses wrong.
   */
  async discussionHistory(discussionID: string, limit: number): Promise<HistoryMessage[]> {
    const discussion = await this.timeout(this.sdk.query.discussion({ discussionId: discussionID }));
    // `last`, not `first`: on a long discussion the useful context is the recent end.
    const page = await this.timeout(discussion.messages({ last: limit }));

    const history: HistoryMessage[] = [];
    for (const message of page.nodes) {
      if (message.type !== "OUTBOUND" && message.type !== "INBOUND") continue;
      // A discussion's messages include the tool calls and approval cards this agent wrote. They
      // are machinery, not conversation, and feeding them back reads as the model talking to itself.
      if (isMachinery(message.entry?.__typename)) continue;

      const content = (message.text ?? "").trim();
      if (content === "") continue;
      history.push({ role: message.type === "OUTBOUND" ? "user" : "assistant", content });
    }
    return history;
  }

  /** One thread with its customer's name, for naming a reply's target on the approval card. */
  async threadTarget(threadID: string): Promise<ThreadTarget> {
    const thread = await this.timeout(this.sdk.query.thread({ threadId: threadID }));
    if (thread === null) throw new Error(`thread ${threadID} not found`);

    const customer = await this.timeout(Promise.resolve(thread.customer));
    return {
      id: thread.id,
      title: thread.title,
      status: String(thread.status),
      customerName: customer?.fullName ?? "unknown customer",
    };
  }

  /**
   * The support queue. `TODO` is what "in the queue" means.
   *
   * This is what makes a Sidekick session useful when it was opened on nothing: without it the
   * agent knows only the one thread it was handed, or none at all.
   */
  async listThreadQueue(status: ThreadStatus, limit: number): Promise<ThreadSummary[]> {
    const page = await this.timeout(
      this.sdk.query.threads({ filters: { statuses: [status] }, first: limit }),
    );
    return page.nodes.map((thread) => ({
      id: thread.id,
      title: thread.title,
      status: String(thread.status),
    }));
  }

  /** Full-text search across threads, for finding one by what it is about. */
  async searchThreads(query: string, limit: number): Promise<ThreadSummary[]> {
    const result = await this.timeout(
      this.sdk.query.searchThreads({ searchQuery: { term: query }, first: limit }),
    );
    return result.edges.map((edge) => ({
      id: edge.node.thread.id,
      title: edge.node.thread.title,
      status: String(edge.node.thread.status),
    }));
  }

  // ---- writing to the customer's thread ----

  /** Sends a reply to the customer through whichever channel the thread uses. */
  async replyToThread(threadID: string, markdown: string): Promise<void> {
    const result = await this.timeout(
      this.sdk.mutation.replyToThread({
        // Both fields every time: textContent is what clients that cannot render markdown show.
        input: { threadId: threadID, textContent: markdown, markdownContent: markdown },
      }),
    );
    this.assertOK("replyToThread", result.error ?? null);
  }

  // ---- the discussion the agent runs in ----

  async sendDiscussionMessage(discussionID: string, markdown: string): Promise<void> {
    const result = await this.timeout(
      this.sdk.mutation.sendDiscussionMessage({
        input: { discussionId: discussionID, markdownContent: markdown },
      }),
    );
    this.assertOK("sendDiscussionMessage", result.error ?? null);
  }

  // Plain runs no session for a custom agent, so without this the discussion looks permanently
  // idle. Posting the reply is what marks it unread, not this.
  async setDiscussionAgentStatus(
    discussionID: string,
    status: DiscussionAgentStatus,
  ): Promise<void> {
    const result = await this.timeout(
      this.sdk.mutation.updateDiscussionAgentStatus({
        input: { discussionId: discussionID, agentStatus: status },
      }),
    );
    this.assertOK("updateDiscussionAgentStatus", result.error ?? null);
  }

  /**
   * Puts one line on the discussion timeline per call the model makes.
   *
   * `toolCallId` is ours to choose and must be unique in the discussion, because an approval names
   * a call by it. SUCCESS and ERROR are final: a later write to a settled call is a NOOP.
   */
  async upsertToolCall(
    discussionID: string,
    toolCallID: string,
    status: ToolCallStatus,
    text: string,
    error?: string,
  ): Promise<void> {
    const result = await this.timeout(
      this.sdk.mutation.upsertDiscussionToolCall({
        input: { discussionId: discussionID, toolCallId: toolCallID, status, text, error },
      }),
    );
    this.assertOK("upsertDiscussionToolCall", result.error ?? null);
  }

  // Idempotent by toolCallId: asking twice returns the same approval rather than a second card.
  async requestApproval(
    discussionID: string,
    toolCallID: string,
    justification: string,
  ): Promise<void> {
    const result = await this.timeout(
      this.sdk.mutation.requestDiscussionToolCallApproval({
        input: { discussionId: discussionID, toolCallId: toolCallID, justification },
      }),
    );
    this.assertOK("requestDiscussionToolCallApproval", result.error ?? null);
  }

  /**
   * Reads the approval entry for one call, or null while nobody has decided.
   *
   * `last` rather than `first`: the approval sits at the end of the timeline, so a page taken from
   * the start would miss it on any discussion of length.
   */
  async approvalOutcome(discussionID: string, toolCallID: string): Promise<ApprovalOutcome | null> {
    return this.timeout(
      (async () => {
        const discussion = await this.sdk.query.discussion({ discussionId: discussionID });
        const page = await discussion.messages({ last: 50 });

        for (const message of page.nodes) {
          const entry = message.entry;
          if (entry?.__typename !== "ThreadDiscussionToolCallApprovalEntryPayload") continue;
          if (entry.toolCallId !== toolCallID) continue;
          if (entry.status === "APPROVED") return { decision: "APPROVED" as const };
          if (entry.status === "DENIED") {
            return { decision: "DENIED" as const, reviewerNote: entry.reviewerNote ?? null };
          }
          return null;
        }
        return null;
      })(),
    );
  }

  private async timeout<T>(work: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expiry = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Plain call timed out after ${REQUEST_TIMEOUT_MS}ms`)),
        REQUEST_TIMEOUT_MS,
      );
    });

    try {
      return await Promise.race([work, expiry]);
    } finally {
      clearTimeout(timer);
    }
  }

  // The SDK returns errors in the payload rather than throwing, so an unchecked call looks like it
  // worked. Every mutation above goes through here.
  private assertOK(call: string, error: MutationError): void {
    if (error === null) return;
    throw new Error(`${call} failed: ${error.message} (${error.code})`);
  }
}
