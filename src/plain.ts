import {
  DISCUSSION_MESSAGE_CREATED_EVENT,
  WEBHOOK_TARGET_VERSION,
  truncate,
} from "./config.ts";

export type MachineUser = {
  id: string;
  fullName: string;
  publicName: string;
  isCustomAgent: boolean;
};

export type WebhookTarget = {
  id: string;
  url: string;
  version: string;
  isEnabled: boolean;
  description: string;
  eventSubscriptions: { eventType: string }[];
};

export type Discussion = {
  id: string;
  title: string;
  threadId: string | null;
  status: string;
  agentStatus: string;
  thread: {
    id: string;
    title: string;
    customer: { id: string; fullName: string } | null;
  } | null;
};

type MutationError = { message: string; type: string; code: string } | null;

const WEBHOOK_TARGET_FIELDS = "id url version isEnabled description eventSubscriptions { eventType }";

function mutationError(error: MutationError): Error | null {
  if (!error) return null;
  return new Error(`plain rejected the call: ${error.message} (${error.code})`);
}

export class PlainClient {
  constructor(
    private readonly apiURL: string,
    private readonly apiKey: string,
  ) {}

  private async request<T>(
    query: string,
    variables: Record<string, unknown> | null,
    signal?: AbortSignal,
  ): Promise<T> {
    const res = await fetch(this.apiURL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables }),
      signal: signal ?? AbortSignal.timeout(30_000),
    });

    const raw = await res.text();

    // Parse the envelope whatever the status code. A FORBIDDEN response is a 403 whose body still
    // carries the real message; dumping the raw body instead re-encodes its quotes and makes the
    // error unreadable to anything trying to match on it.
    let envelope: { data?: T; errors?: { message: string }[] };
    try {
      envelope = JSON.parse(raw);
    } catch {
      throw new Error(
        `plain api returned ${res.status} with unparseable json: ${truncate(raw, 300)}`,
      );
    }
    if (envelope.errors?.length) {
      throw new Error(`graphql error: ${envelope.errors[0]!.message}`);
    }
    if (!res.ok) {
      throw new Error(`plain api returned ${res.status}: ${truncate(raw, 300)}`);
    }
    return envelope.data as T;
  }

  /**
   * Identifies which machine user this API key belongs to. The agent needs its own id to tell the
   * discussions it owns from Sidekick's and from other agents'.
   */
  async myMachineUser(): Promise<MachineUser> {
    const data = await this.request<{ myMachineUser: MachineUser | null }>(
      "query { myMachineUser { id fullName publicName isCustomAgent } }",
      null,
    );
    if (!data.myMachineUser) throw new Error("this API key does not belong to a machine user");
    return data.myMachineUser;
  }

  /**
   * The same secret Plain signs outbound webhooks with, so the agent can fetch it instead of having
   * it pasted in. Human-user only in practice, so callers must handle the failure.
   */
  async workspaceHmacSecret(): Promise<string> {
    const data = await this.request<{ workspaceHmac: { hmacSecret: string | null } | null }>(
      "query { workspaceHmac { hmacSecret } }",
      null,
    );
    const secret = data.workspaceHmac?.hmacSecret;
    if (!secret) throw new Error("no workspace HMAC secret has been generated yet");
    return secret;
  }

  async webhookTargets(): Promise<WebhookTarget[]> {
    const data = await this.request<{
      webhookTargets: { edges: { node: WebhookTarget }[] };
    }>(`query { webhookTargets(first: 100) { edges { node { ${WEBHOOK_TARGET_FIELDS} } } } }`, null);
    return data.webhookTargets.edges.map((edge) => edge.node);
  }

  async createWebhookTarget(url: string, description: string): Promise<WebhookTarget> {
    const data = await this.request<{
      createWebhookTarget: { webhookTarget: WebhookTarget | null; error: MutationError };
    }>(
      `mutation ($input: CreateWebhookTargetInput!) {
        createWebhookTarget(input: $input) {
          webhookTarget { ${WEBHOOK_TARGET_FIELDS} }
          error { message type code }
        }
      }`,
      {
        input: {
          url,
          description,
          isEnabled: true,
          version: WEBHOOK_TARGET_VERSION,
          eventSubscriptions: [{ eventType: DISCUSSION_MESSAGE_CREATED_EVENT }],
        },
      },
    );
    const failure = mutationError(data.createWebhookTarget.error);
    if (failure) throw failure;
    if (!data.createWebhookTarget.webhookTarget) {
      throw new Error("createWebhookTarget returned no target");
    }
    return data.createWebhookTarget.webhookTarget;
  }

  /**
   * Repoints an existing target, which is what you want every time ngrok hands you a new hostname.
   */
  async updateWebhookTarget(targetID: string, url: string): Promise<WebhookTarget> {
    const data = await this.request<{
      updateWebhookTarget: { webhookTarget: WebhookTarget | null; error: MutationError };
    }>(
      `mutation ($input: UpdateWebhookTargetInput!) {
        updateWebhookTarget(input: $input) {
          webhookTarget { ${WEBHOOK_TARGET_FIELDS} }
          error { message type code }
        }
      }`,
      {
        input: {
          webhookTargetId: targetID,
          url: { value: url },
          isEnabled: { value: true },
          version: { value: WEBHOOK_TARGET_VERSION },
          eventSubscriptions: [{ eventType: DISCUSSION_MESSAGE_CREATED_EVENT }],
        },
      },
    );
    const failure = mutationError(data.updateWebhookTarget.error);
    if (failure) throw failure;
    if (!data.updateWebhookTarget.webhookTarget) {
      throw new Error("updateWebhookTarget returned no target");
    }
    return data.updateWebhookTarget.webhookTarget;
  }

  /**
   * Only used for the extra context handed to the model on the first turn of a discussion, so a
   * failure here is never fatal to answering.
   */
  async discussion(discussionID: string, signal?: AbortSignal): Promise<Discussion> {
    const data = await this.request<{ discussion: Discussion | null }>(
      `query ($discussionId: ID!) {
        discussion(discussionId: $discussionId) {
          id title threadId status agentStatus
          thread { id title customer { id fullName } }
        }
      }`,
      { discussionId: discussionID },
      signal,
    );
    if (!data.discussion) throw new Error(`discussion ${discussionID} not found`);
    return data.discussion;
  }

  async sendDiscussionMessage(discussionID: string, markdown: string): Promise<string> {
    const data = await this.request<{
      sendDiscussionMessage: {
        discussionMessage: { id: string } | null;
        error: MutationError;
      };
    }>(
      `mutation ($input: SendDiscussionMessageInput!) {
        sendDiscussionMessage(input: $input) {
          discussionMessage { id }
          error { message type code }
        }
      }`,
      { input: { discussionId: discussionID, markdownContent: markdown } },
    );
    const failure = mutationError(data.sendDiscussionMessage.error);
    if (failure) throw failure;
    if (!data.sendDiscussionMessage.discussionMessage) {
      throw new Error("sendDiscussionMessage returned no message");
    }
    return data.sendDiscussionMessage.discussionMessage.id;
  }

  /**
   * Not optional housekeeping: Plain runs no session for a custom agent, so without these calls the
   * discussion shows as permanently idle. Settling on IDLE is also what marks the discussion unread
   * so the answer surfaces.
   */
  async updateAgentStatus(discussionID: string, status: string): Promise<void> {
    const data = await this.request<{
      updateDiscussionAgentStatus: {
        discussion: { id: string; agentStatus: string } | null;
        error: MutationError;
      };
    }>(
      `mutation ($input: UpdateDiscussionAgentStatusInput!) {
        updateDiscussionAgentStatus(input: $input) {
          discussion { id agentStatus }
          error { message type code }
        }
      }`,
      { input: { discussionId: discussionID, agentStatus: status } },
    );
    const failure = mutationError(data.updateDiscussionAgentStatus.error);
    if (failure) throw failure;
  }

  /**
   * The permissions granted to the key in use. Needs apiKey:read, which a key often does not hold,
   * so callers must handle the failure rather than depend on it.
   */
  async myApiKeyPermissions(): Promise<string[]> {
    const data = await this.request<{
      myMachineUser: {
        apiKeys: {
          edges: { node: { id: string; isDeleted: boolean; permissions: string[] } }[];
        };
      } | null;
    }>(
      "query { myMachineUser { apiKeys(first: 50) { edges { node { id isDeleted permissions } } } } }",
      null,
    );
    if (!data.myMachineUser) throw new Error("this API key does not belong to a machine user");

    // The API never reveals which key authenticated the request, and a machine user may hold
    // several. Only a single live key makes the answer unambiguous.
    const live = data.myMachineUser.apiKeys.edges
      .map((edge) => edge.node)
      .filter((node) => !node.isDeleted);
    if (live.length !== 1) {
      throw new Error(
        `this machine user has ${live.length} live API keys, so the permissions of the one in use cannot be identified`,
      );
    }
    return live[0]!.permissions;
  }
}
