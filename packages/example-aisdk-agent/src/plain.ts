import { PlainClient as PlainSDK } from "@team-plain/graphql";

// A stuck call must not hold a turn open, and no call here is slow enough to want longer.
const REQUEST_TIMEOUT_MS = 30_000;

// One page of timeline entries. Large enough that most threads read in a single call.
const TIMELINE_PAGE = 50;

export type ThreadAgentStatus = "IN_PROGRESS" | "HANDLED" | "HANDED_OFF";
export type DiscussionAgentStatus = "IN_PROGRESS" | "IDLE";
export type ToolCallStatus = "PENDING" | "SUCCESS" | "ERROR";

export type ApprovalOutcome =
  | { decision: "APPROVED" }
  | { decision: "DENIED"; reviewerNote: string | null };

type MutationError = { message: string; code: string } | null;

/**
 * Both surfaces' calls on one client.
 *
 * Together on purpose: splitting it would hide how much they share (one key, one endpoint) and how
 * little they overlap (no mutation below serves both).
 */
export class Plain {
  private readonly sdk: PlainSDK;

  constructor(apiKey: string, apiURL: string) {
    this.sdk = new PlainSDK({ apiKey, apiUrl: apiURL });
  }

  async myMachineUserID(): Promise<string> {
    const me = await this.timeout(this.sdk.query.myMachineUser());
    return me.id;
  }

  // ---- the support-agent surface, on a customer thread ----

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

  /**
   * Drafts a reply for a person to review, edit and send. The customer sees nothing until someone
   * sends it, which makes this the safer default while an agent is being tuned.
   */
  async suggestReply(threadID: string, timelineEntryID: string, markdown: string): Promise<void> {
    const result = await this.timeout(
      this.sdk.mutation.addGeneratedReply({
        input: { threadId: threadID, timelineEntryId: timelineEntryID, markdown },
      }),
    );
    this.assertOK("addGeneratedReply", result.error ?? null);
  }

  /** An internal note on the thread timeline. Never delivered to the customer. */
  async createNote(threadID: string, customerID: string, markdown: string): Promise<void> {
    const result = await this.timeout(
      this.sdk.mutation.createNote({
        input: { threadId: threadID, customerId: customerID, text: markdown, markdown },
      }),
    );
    this.assertOK("createNote", result.error ?? null);
  }

  async addLabels(threadID: string, labelTypeIDs: string[]): Promise<void> {
    const result = await this.timeout(
      this.sdk.mutation.addLabels({ input: { threadId: threadID, labelTypeIds: labelTypeIDs } }),
    );
    this.assertOK("addLabels", result.error ?? null);
  }

  async assignToUser(threadID: string, userID: string): Promise<void> {
    const result = await this.timeout(
      this.sdk.mutation.assignThread({ input: { threadId: threadID, userId: userID } }),
    );
    this.assertOK("assignThread", result.error ?? null);
  }

  async unassignThread(threadID: string): Promise<void> {
    const result = await this.timeout(
      this.sdk.mutation.unassignThread({ input: { threadId: threadID } }),
    );
    this.assertOK("unassignThread", result.error ?? null);
  }

  async markThreadAsTodo(threadID: string): Promise<void> {
    const result = await this.timeout(
      this.sdk.mutation.markThreadAsTodo({ input: { threadId: threadID } }),
    );
    this.assertOK("markThreadAsTodo", result.error ?? null);
  }

  /**
   * Reports the agent's progress on a thread.
   *
   * Only HANDED_OFF threads appear in the First Response, Next Response and Investigating queues,
   * which is the point: work the agent is handling stays out of a person's view.
   */
  async setThreadAgentStatus(threadID: string, status: ThreadAgentStatus): Promise<void> {
    const result = await this.timeout(
      this.sdk.mutation.updateThreadAgentStatus({
        input: { threadId: threadID, agentStatus: status },
      }),
    );
    this.assertOK("updateThreadAgentStatus", result.error ?? null);
  }

  // ---- the internal-agent surface, on a Sidekick discussion ----

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
