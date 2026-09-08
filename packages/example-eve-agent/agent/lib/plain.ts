import { PlainClient as PlainSDK } from "@team-plain/graphql";

// A stuck call must not hold a turn open, and no call here is slow enough to want longer.
const REQUEST_TIMEOUT_MS = 30_000;

const PROD_API_URL = "https://core-api.uk.plain.com/graphql/v1";

export type AgentStatus = "IN_PROGRESS" | "IDLE";
export type ToolCallStatus = "PENDING" | "SUCCESS" | "ERROR";

type MutationError = { message: string; code: string } | null;

/**
 * Every write this example makes back to Plain.
 *
 * Deliberately not in `agent/connections/`: eve reserves that directory for MCP and OpenAPI
 * servers whose tools it discovers and offers to the model. These calls are channel plumbing the
 * model never sees, so they live in a plain module the channel imports.
 */
export class Plain {
  private readonly sdk: PlainSDK;

  constructor(apiKey: string, apiURL: string = PROD_API_URL) {
    this.sdk = new PlainSDK({ apiKey, apiUrl: apiURL });
  }

  /** The agent's own machine user id, used to reject deliveries caused by its own replies. */
  async myMachineUserID(): Promise<string> {
    const me = await this.timeout(this.sdk.query.myMachineUser());
    return me.id;
  }

  async sendMessage(discussionID: string, markdown: string): Promise<void> {
    const result = await this.timeout(
      this.sdk.mutation.sendDiscussionMessage({
        input: { discussionId: discussionID, markdownContent: markdown },
      }),
    );
    this.assertOK("sendDiscussionMessage", result.error ?? null);
  }

  // Plain runs no session for a custom agent, so without these calls the discussion shows as
  // permanently idle. Posting the reply is what marks it unread, not this.
  async setAgentStatus(discussionID: string, status: AgentStatus): Promise<void> {
    const result = await this.timeout(
      this.sdk.mutation.updateDiscussionAgentStatus({
        input: { discussionId: discussionID, agentStatus: status },
      }),
    );
    this.assertOK("updateDiscussionAgentStatus", result.error ?? null);
  }

  /**
   * Reports one call on the discussion timeline. `toolCallId` is ours to choose and must be unique
   * within the discussion, because an approval names a call by it. SUCCESS and ERROR are final: a
   * later write to a settled call returns NOOP and changes nothing.
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

  // Idempotent by toolCallId: asking twice returns the same approval rather than a second card, so
  // a retried delivery is safe. The call must already be reported and still PENDING.
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

  private async timeout<T>(work: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expiry = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Plain call timed out after ${REQUEST_TIMEOUT_MS}ms`)), REQUEST_TIMEOUT_MS);
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
