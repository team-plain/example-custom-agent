import { PlainClient as PlainSDK } from "@team-plain/graphql";
import { API_URL } from "./config.ts";

/** A stuck call must not hold a turn open, and no call here is slow enough to want longer. */
const REQUEST_TIMEOUT_MS = 30_000;

export type MachineUser = {
  id: string;
  fullName: string;
  isCustomAgent: boolean;
};

export type WebhookTarget = {
  url: string;
  version: string;
  isEnabled: boolean;
  eventSubscriptions: { eventType: string }[];
};

export type Discussion = {
  id: string;
  thread: { title: string; customer: { fullName: string } | null } | null;
};

type ReturnedMutationError = {
  message: string;
  code: string;
  fields?: { field: string; message: string }[];
} | null;

export class PlainClient {
  private readonly sdk: PlainSDK;

  constructor(apiKey: string) {
    this.sdk = new PlainSDK({ apiKey, apiUrl: API_URL });
  }

  /**
   * Identifies which machine user this API key belongs to. The agent needs its own id to tell the
   * discussions it owns from Sidekick's and from other agents'.
   *
   * `isCustomAgent` is the Custom agent toggle. Do not reach for `type` instead: it answers
   * AI_AGENT or API_USER, which is a different question, and a working custom agent can be
   * API_USER.
   */
  async myMachineUser(): Promise<MachineUser> {
    const me = await withTimeout(this.sdk.query.myMachineUser(), REQUEST_TIMEOUT_MS);
    return { id: me.id, fullName: me.fullName, isCustomAgent: me.isCustomAgent };
  }

  async webhookTargets(): Promise<WebhookTarget[]> {
    const page = await withTimeout(
      this.sdk.query.webhookTargets({ first: 100 }),
      REQUEST_TIMEOUT_MS,
    );
    return page.nodes.map((target) => ({
      url: target.url,
      version: target.version,
      isEnabled: target.isEnabled,
      eventSubscriptions: target.eventSubscriptions,
    }));
  }

  /**
   * Only used for the extra context handed to the model on the first turn of a discussion, so a
   * failure here is never fatal to answering. `thread` and `customer` are lazy getters, so this
   * costs a round trip each rather than arriving with the discussion.
   */
  async discussion(discussionID: string, timeoutMS = REQUEST_TIMEOUT_MS): Promise<Discussion> {
    return withTimeout(
      (async () => {
        const discussion = await this.sdk.query.discussion({ discussionId: discussionID });
        const thread = await discussion.thread;
        if (!thread) return { id: discussion.id, thread: null };

        const customer = await thread.customer;
        return {
          id: discussion.id,
          thread: {
            title: thread.title,
            customer: customer ? { fullName: customer.fullName } : null,
          },
        };
      })(),
      timeoutMS,
    );
  }

  async sendDiscussionMessage(discussionID: string, markdown: string): Promise<string> {
    const result = await withTimeout(
      this.sdk.mutation.sendDiscussionMessage({
        input: { discussionId: discussionID, markdownContent: markdown },
      }),
      REQUEST_TIMEOUT_MS,
    );

    assertNoMutationError("sendDiscussionMessage", result.error ?? null);
    if (!result.discussionMessage) throw new Error("sendDiscussionMessage returned no message");
    return result.discussionMessage.id;
  }

  /**
   * Not optional housekeeping: Plain runs no session for a custom agent, so without these calls the
   * discussion shows as permanently idle. Settling on IDLE is also what marks the discussion unread
   * so the answer surfaces.
   *
   * Note this is the discussion mutation, not the SDK's `updateThreadAgentStatus`, which takes a
   * thread id and sets the status somewhere else entirely.
   */
  async updateAgentStatus(discussionID: string, status: "IN_PROGRESS" | "IDLE"): Promise<void> {
    const result = await withTimeout(
      this.sdk.mutation.updateDiscussionAgentStatus({
        input: { discussionId: discussionID, agentStatus: status },
      }),
      REQUEST_TIMEOUT_MS,
    );

    assertNoMutationError("updateDiscussionAgentStatus", result.error ?? null);
  }

  /**
   * Moves the discussion itself between OPEN and RESOLVED. This is the conversation's state, not the
   * agent's: `updateAgentStatus` says what the agent is doing inside a turn, this says the whole
   * exchange is over.
   */
  async changeDiscussionStatus(discussionID: string, status: "OPEN" | "RESOLVED"): Promise<void> {
    const result = await withTimeout(
      this.sdk.mutation.changeThreadDiscussionStatus({
        input: { threadDiscussionId: discussionID, status },
      }),
      REQUEST_TIMEOUT_MS,
    );

    assertNoMutationError("changeThreadDiscussionStatus", result.error ?? null);
  }

  /**
   * The permissions granted to the key in use. Needs apiKey:read, which a key often does not hold,
   * so callers must handle the failure rather than depend on it.
   */
  async myApiKeyPermissions(): Promise<string[]> {
    const keys = await withTimeout(
      (async () => {
        const me = await this.sdk.query.myMachineUser();
        return me.apiKeys({ first: 50 });
      })(),
      REQUEST_TIMEOUT_MS,
    );

    // The API never reveals which key authenticated the request, and a machine user may hold
    // several. Only a single live key makes the answer unambiguous.
    const live = keys.nodes.filter((key) => !key.isDeleted);
    if (live.length !== 1) {
      throw new Error(
        `this machine user has ${live.length} live API keys, so the permissions of the one in use cannot be identified`,
      );
    }
    return live[0]!.permissions;
  }
}

/**
 * Plain answers a refused mutation with HTTP 200 and an `error` object inside `data`. The SDK passes
 * that payload straight back rather than throwing, so every mutation has to check it.
 */
function assertNoMutationError(name: string, error: ReturnedMutationError): void {
  if (!error) return;

  const fields = error.fields?.map((field) => `${field.field}: ${field.message}`).join(", ");
  const detail = fields ? ` [${fields}]` : "";
  throw new Error(`plain rejected ${name}: ${error.message} (${error.code})${detail}`);
}

/**
 * The SDK client takes no AbortSignal, so this only stops waiting. The request itself runs on until
 * Plain answers it.
 */
async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`plain did not answer within ${ms}ms`)), ms);
  });

  try {
    return await Promise.race([work, expiry]);
  } finally {
    clearTimeout(timer);
  }
}
