import { PORT, WEBHOOK_PATH, type Config } from "./config.ts";
import type { ProviderName } from "./providers.ts";
import { bold, cyan, dim, fail, green, label, red, warn } from "./ui.ts";
import { Runner } from "./runner.ts";
import type { MachineUser, PlainClient } from "./plain.ts";
import {
  SIGNATURE_HEADER,
  classify,
  describeActor,
  discussionMessage,
  verify,
  type DiscussionMessageCreatedPayload,
  type Envelope,
} from "./webhook.ts";

const MAX_BODY_BYTES = 4 << 20;

class Agent {
  /** Plain retries a delivery it thinks failed, and the agent must not answer the same turn twice. */
  private readonly seen = new Set<string>();

  constructor(
    private readonly client: PlainClient,
    private readonly runner: Runner,
    private readonly me: MachineUser,
    private readonly secret: string,
    private readonly resolveWhenDone: boolean,
  ) {}

  async handleWebhook(req: Request): Promise<Response> {
    if (req.method !== "POST") {
      return new Response("POST only\n", { status: 405 });
    }

    const body = await req.text();
    if (body.length > MAX_BODY_BYTES) {
      return new Response("body too large\n", { status: 413 });
    }

    let envelope: Envelope;
    try {
      envelope = verify(body, req.headers.get(SIGNATURE_HEADER) ?? "", this.secret);
    } catch (err) {
      // Bad signature, stale delivery, or a PlainWebhookVersionMismatchError, which means the
      // webhook target and the installed SDK disagree on the version. Retrying fixes none of them.
      console.log(`${red("rejected")} ${message(err)}`);
      return new Response("rejected\n", { status: 401 });
    }

    // Answer before doing the work. Plain retries anything that is not a 2xx, and a Claude turn
    // takes far longer than the delivery timeout, so this is deliberately not awaited.
    void this.dispatch(envelope);
    return new Response("ok\n");
  }

  private async dispatch(envelope: Envelope): Promise<void> {
    const payload = discussionMessage(envelope);
    if (!payload) {
      console.log(`${dim(envelope.id)} ignoring ${envelope.type}`);
      return;
    }

    const verdict = classify(payload, this.me.id);
    if (!verdict.answer) {
      console.log(`${dim(envelope.id)} skipped: ${verdict.reason}`);
      return;
    }

    if (this.seen.has(payload.message.id)) {
      console.log(`${dim(envelope.id)} already answered ${payload.message.id}`);
      return;
    }
    this.seen.add(payload.message.id);

    await this.respond(payload);
  }

  private async respond(payload: DiscussionMessageCreatedPayload): Promise<void> {
    const discussionID = payload.discussion.id;
    console.log(`${dim(discussionID)} answering a turn from ${describeActor(payload.message.createdBy)}`);

    // Not fatal: the answer still matters even if the spinner never appears.
    await this.setStatus(discussionID, "IN_PROGRESS");

    const prompt = await this.buildPrompt(payload);

    let answer: string;
    try {
      answer = await this.runner.ask(discussionID, prompt);
    } catch (err) {
      console.log(`${dim(discussionID)} ${red("claude failed")} ${message(err)}`);
      const report = `I could not answer that. My runner failed with:\n\n\`\`\`\n${message(err)}\n\`\`\``;
      try {
        await this.client.sendDiscussionMessage(discussionID, report);
      } catch (sendErr) {
        console.log(`${dim(discussionID)} ${red("could not report the failure")} ${message(sendErr)}`);
      }
      // IDLE, not NEEDS_INPUT: the report above is the input request. NEEDS_INPUT is for an agent
      // blocked on a person, such as an approval, which is not what a failed turn is.
      await this.setStatus(discussionID, "IDLE");
      return;
    }

    try {
      const messageID = await this.client.sendDiscussionMessage(discussionID, answer);
      console.log(`${dim(discussionID)} ${green("answered")} ${messageID} (${answer.length} chars)`);
    } catch (err) {
      console.log(`${dim(discussionID)} ${red("could not post the answer")} ${message(err)}`);
      return;
    }

    // IDLE last: settling on it is what marks the discussion unread so the answer surfaces.
    await this.setStatus(discussionID, "IDLE");

    if (this.resolveWhenDone) await this.resolve(discussionID);
  }

  /**
   * Closes the discussion once the agent has answered. Opt-in via PLAIN_RESOLVE_WHEN_DONE, because
   * this example has no way of telling a finished conversation from a pause, and resolving a live
   * one hides it from the customer. A real agent should decide this per turn.
   */
  private async resolve(discussionID: string): Promise<void> {
    try {
      await this.client.changeDiscussionStatus(discussionID, "RESOLVED");
      console.log(`${dim(discussionID)} ${dim("resolved")}`);
    } catch (err) {
      console.log(`${dim(discussionID)} ${dim("could not resolve")} ${message(err)}`);
    }
  }

  private async setStatus(
    discussionID: string,
    status: "IN_PROGRESS" | "IDLE",
  ): Promise<void> {
    try {
      await this.client.updateAgentStatus(discussionID, status);
      console.log(`${dim(discussionID)} ${dim("status")} ${status}`);
    } catch (err) {
      console.log(`${dim(discussionID)} ${dim(`could not set ${status}`)} ${message(err)}`);
    }
  }

  /**
   * Hands the model the thread it is being asked about on the first turn only. Later turns resume
   * the same Claude session, which already holds that context.
   */
  private async buildPrompt(payload: DiscussionMessageCreatedPayload): Promise<string> {
    if (await this.runner.isResuming(payload.discussion.id)) {
      return payload.message.markdown;
    }
    if (!payload.discussion.threadId) {
      return payload.message.markdown;
    }

    try {
      const discussion = await this.client.discussion(payload.discussion.id, 15_000);
      if (!discussion.thread) return payload.message.markdown;

      const lines = [
        "You have been asked about a Plain support thread.",
        `Thread title: ${discussion.thread.title}`,
      ];
      if (discussion.thread.customer) {
        lines.push(`Customer: ${discussion.thread.customer.fullName}`);
      }
      return `${lines.join("\n")}\n\n${payload.message.markdown}`;
    } catch (err) {
      console.log(`${dim(payload.discussion.id)} ${dim("could not read thread context")} ${message(err)}`);
      return payload.message.markdown;
    }
  }
}

export async function runServe(
  client: PlainClient,
  config: Config,
  provider: ProviderName,
): Promise<void> {
  const me = await client.myMachineUser();
  console.log(`${label("machine user")}${bold(me.id)} ${me.fullName}`);
  if (!me.isCustomAgent) {
    console.log(fail("this machine user is not a custom agent, so it stays out of the picker"));
  }

  const runner = await Runner.create(provider);
  const agent = new Agent(client, runner, me, config.secret, config.resolveWhenDone);

  Bun.serve({
    port: PORT,
    idleTimeout: 30,
    routes: {
      [WEBHOOK_PATH]: (req: Request) => agent.handleWebhook(req),
      "/health": () => new Response("ok\n"),
    },
    fetch: () => new Response("not found\n", { status: 404 }),
  });

  console.log(`${label("provider")}${bold(provider)}`);
  console.log(`${label("listening on")}:${PORT}${WEBHOOK_PATH}`);
  if (config.publicURL !== "") {
    console.log(`${label("webhook url")}${cyan(config.publicURL + WEBHOOK_PATH)}`);
  }
  console.log(
    warn(
      provider === "claude"
        ? "claude runs unsandboxed in auto mode with the whole filesystem in reach"
        : `${provider} runs with whatever permissions its own config grants it`,
    ),
  );
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
