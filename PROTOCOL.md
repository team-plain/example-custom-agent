# Building your own custom agent

This document outlines the protocol details that this agent relies on. Use this to understand how the mechanism work and port it to any language or setup as needed.

Every step is shown twice: **with the SDK** ([team-plain/sdk](https://github.com/team-plain/sdk),
what this project uses) and **by hand** over raw HTTP, which is what you need in any other language.

## The SDK

[team-plain/sdk](https://github.com/team-plain/sdk) is a monorepo of independently published
packages. This project uses two of them:

| Package | Version | What it is |
| --- | --- | --- |
| [`@team-plain/graphql`](https://www.npmjs.com/package/@team-plain/graphql) | 1.7.0 | Typed client with generated model classes |
| [`@team-plain/webhooks`](https://www.npmjs.com/package/@team-plain/webhooks) | 1.7.1 | Webhook parsing and signature verification |
| [`@team-plain/ui-components`](https://www.npmjs.com/package/@team-plain/ui-components) | 5.0.0 | UI component builders, not needed here |

```bash
bun add @team-plain/graphql @team-plain/webhooks
```

```ts
import { PlainClient } from "@team-plain/graphql";

const client = new PlainClient({ apiKey: process.env.PLAIN_API_KEY! });

await client.query.myMachineUser();                              // queries under .query
await client.mutation.sendDiscussionMessage({ input: { … } });    // mutations under .mutation
```

**Use `@team-plain/graphql` 1.7.0 or newer and `@team-plain/webhooks` 1.7.1 or newer.** `changeThreadDiscussionStatus` landed in 1.5.0; the tool call approval mutations landed in 1.7.0.

On a tool call entry, read **`status`**, not `isSuccess`. `isSuccess` is deprecated and is removed once 1.6 has
propagated. It is also lossy: a call still `PENDING` reads `false`, so the boolean cannot tell "not finished" from
"failed". `status` is `PENDING`, `SUCCESS` or `ERROR`. On the same entry `service` and `op` are now nullable, and
are null on a call an agent reported, because Plain has no name for it.

Do not confuse with [`@team-plain/typescript-sdk`](https://www.npmjs.com/package/@team-plain/typescript-sdk),
the previous generation of the SDK. That package is deprecated.

## What you need in Plain

A machine user with an API key, the Custom agent toggle on, and a webhook target. See the
[README](README.md) for the click path. Minimum permissions:

- `threadDiscussionMessage:create` to post the answer
- `threadDiscussion:read` and `threadDiscussion:edit` to report status

## 1. The webhook you receive

Plain POSTs `discussion.message_created` to your URL every time a message lands in a discussion,
including the ones your own agent writes. These are the fields that matter:

```json
{
  "id": "ev_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  "type": "discussion.message_created",
  "timestamp": "2026-08-20T12:00:00Z",
  "workspaceId": "w_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  "webhookMetadata": { "webhookTargetVersion": "2026-08-19" },
  "payload": {
    "eventType": "discussion.message_created",
    "discussion": {
      "id": "thd_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      "type": "AGENT_SESSION",
      "status": "OPEN",
      "threadId": "th_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      "agent": { "id": "mu_01ARZ3NDEKTSV4RRFFQ69G5FAV" }
    },
    "message": {
      "id": "thdm_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      "type": "OUTBOUND",
      "markdown": "why did this customer's invoice fail?",
      "createdBy": { "actorType": "user", "userId": "u_01ARZ3NDEKTSV4RRFFQ69G5FAV" },
      "createdAt": "2026-08-20T12:00:00Z"
    }
  }
}
```

`discussion.agent.id` is the machine user the discussion was opened against, and
`message.markdown` is what the person typed. That is your prompt.

The real delivery also carries `webhookMetadata.webhookTargetId`, `webhookDeliveryAttemptId`,
`webhookDeliveryAttemptNumber`, and `webhookDeliveryAttemptTimestamp`. The attempt number tells you a
retry from a first try; the timestamp is your replay guard.

`DiscussionMessageCreatedPublicEventPayload` from `@team-plain/webhooks` is the generated type for
all of this, so you do not need to restate it.

## 2. Verify the signature

Plain signs the body with your workspace secret ([Settings → Request
Signing](https://app.plain.com/~/settings/request-signing/)) and puts a hex SHA-256 HMAC in the
`Plain-Request-Signature` header.

`verifyPlainWebhook` does the whole job in one call: constant-time HMAC, schema validation, and a
replay window. This is all [`src/webhook.ts`](src/webhook.ts) does.

```ts
import { verifyPlainWebhook } from "@team-plain/webhooks";

const result = verifyPlainWebhook(rawBody, signatureHeader, secret);
if (result.error) throw result.error;

const envelope = result.data;  // union narrowed on envelope.type
```

**By hand, in any language:**

```bash
printf '%s' "$RAW_BODY" | openssl dgst -sha256 -hmac "$PLAIN_WEBHOOK_SECRET" -hex
```

Run it over the **raw bytes** you received. Parsing the JSON and re-encoding it changes the
whitespace and the signature will never match. Compare in constant time.

## 3. Decide whether to answer

Answer only when all of these hold:

| Condition | Why |
| --- | --- |
| `payload.discussion.type == "AGENT_SESSION"` | Other discussion types are not agent conversations |
| `payload.discussion.agent.id == your machine user id` | Otherwise it belongs to Sidekick or to somebody else's agent |
| `payload.message.type == "OUTBOUND"` | **On an agent session, a person's turn is OUTBOUND and your own replies come back as INBOUND.** Get this backwards and the agent answers itself forever |
| `payload.discussion.status != "RESOLVED"` | The conversation is over |

Your own replies arrive back as webhooks, so this filter is not optional.

The SDK has nothing for this step, and it is the one place a mistake is self-inflicted rather than
reported. `classify` in [`src/webhook.ts`](src/webhook.ts) is the whole of it.

## 4. Post your answer

**With the SDK:**

```ts
const result = await client.mutation.sendDiscussionMessage({
  input: {
    discussionId: "thd_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    markdownContent: "The invoice failed because the card was declined.",
  },
});

// Caution: a refused mutation does NOT throw.
if (result.error) throw new Error(result.error.message);
const messageID = result.discussionMessage?.id;
```

**By hand:**

```bash
curl -sX POST https://core-api.uk.plain.com/graphql/v1 \
  -H "Authorization: Bearer $PLAIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "mutation ($input: SendDiscussionMessageInput!) { sendDiscussionMessage(input: $input) { discussionMessage { id } error { message type code } } }",
    "variables": { "input": {
      "discussionId": "thd_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      "markdownContent": "The invoice failed because the card was declined."
    } }
  }'
```

```json
{"data":{"sendDiscussionMessage":{"discussionMessage":null,"error":{"message":"There was a validation error.","type":"VALIDATION","code":"not_found"}}}}
```

## 5. Report status

Plain runs no session for a custom agent, so nothing reports progress unless you do. Without these
calls the discussion looks permanently idle.

**With the SDK:**

```ts
const result = await client.mutation.updateDiscussionAgentStatus({
  input: { discussionId: "thd_01ARZ3NDEKTSV4RRFFQ69G5FAV", agentStatus: "IN_PROGRESS" },
});
if (result.error) throw new Error(result.error.message);
```

**By hand:**

```bash
curl -sX POST https://core-api.uk.plain.com/graphql/v1 \
  -H "Authorization: Bearer $PLAIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "mutation ($input: UpdateDiscussionAgentStatusInput!) { updateDiscussionAgentStatus(input: $input) { discussion { id agentStatus } error { message type code } } }",
    "variables": { "input": {
      "discussionId": "thd_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      "agentStatus": "IN_PROGRESS"
    } }
  }'
```

The sequence per turn is `IN_PROGRESS` → post the answer → `IDLE`. Settle on `IDLE` last: that is what marks the discussion unread, so the answer surfaces.

Settle on `IDLE` when the turn fails too. Post the failure as a message first, so the customer sees
what went wrong, then go `IDLE`: the message you just posted is the request for input, so there is
nothing for `NEEDS_INPUT` to add.

`NEEDS_INPUT` means the agent has stopped and is waiting on a person, an approval being the usual
case. That is a real state and the API still documents it. [ORCA-865](https://linear.app/plain/issue/ORCA-865)
will remove it, so prefer not to build on it, but a failed turn was never what it was for.

### Resolving the conversation

`agentStatus` says what the agent is doing inside a turn. It does not say the conversation is over.
That is the discussion's own status, and it moves with a different mutation:

```ts
const result = await client.mutation.changeThreadDiscussionStatus({
  input: { threadDiscussionId: "thd_01ARZ3NDEKTSV4RRFFQ69G5FAV", status: "RESOLVED" },
});
// status is OPEN | RESOLVED. Resolving is reversible: pass OPEN to reopen.
```

This is how you resolve a discussion, and how you reopen one.

Resolve only when the customer genuinely needs nothing further. A resolved discussion drops out of
their view, so resolving a live conversation loses it. This example keeps the call behind
`PLAIN_RESOLVE_WHEN_DONE=1` and leaves it off, because it cannot tell a finished conversation from a
pause. A real agent should make that judgement per turn.

## 6. Two calls worth having

Identify which machine user your key is, so you can compare it against `discussion.agent.id`:

```ts
const me = await client.query.myMachineUser();
// me.id, me.fullName, me.isCustomAgent
```

**By hand:**

```bash
curl -sX POST https://core-api.uk.plain.com/graphql/v1 \
  -H "Authorization: Bearer $PLAIN_API_KEY" -H "Content-Type: application/json" \
  -d '{"query":"query { myMachineUser { id fullName isCustomAgent } }"}'
```

```json
{"data":{"myMachineUser":{"id":"mu_01ARZ3NDEKTSV4RRFFQ69G5FAV","fullName":"your agent","isCustomAgent":true}}}
```

Read the thread the discussion hangs off, for context on the first turn.

**With the SDK.** `thread` and `customer` are lazy getters, so each one is its own round trip:

```ts
const discussion = await client.query.discussion({ discussionId: "thd_01ARZ3NDEKTSV4RRFFQ69G5FAV" });
const thread = await discussion.thread;
const customer = thread ? await thread.customer : undefined;
```

**By hand, which gets all of it in one:**

```bash
curl -sX POST https://core-api.uk.plain.com/graphql/v1 \
  -H "Authorization: Bearer $PLAIN_API_KEY" -H "Content-Type: application/json" \
  -d '{
    "query": "query ($discussionId: ID!) { discussion(discussionId: $discussionId) { id thread { title customer { fullName } } } }",
    "variables": { "discussionId": "thd_01ARZ3NDEKTSV4RRFFQ69G5FAV" }
  }'
```

## 7. Gating an action on a human

Some actions should not happen because a model decided they should. Plain lets you stop in front of one and
wait for a person, and shows them a card in the app with an Approve and a Deny button.

**This example gates its own writes, not its tool calls, and that is a property of the example rather than
of the API.** It delegates thinking to an external CLI and gets text back, so no tool call ever passes
through its own code and there is nothing to intercept. It writes three things: the reply it posts, the
resolve it may perform, and a notice when its runner dies. **It gates the first two.** The failure notice
stays ungated, because a gated failure notice can itself fail and then the discussion says nothing at all;
what it does instead is drop the runner's raw output while the gate is on, since that text is whatever the
CLI printed and no human has read it. **A real agent with a tool loop gates tool calls in exactly the same
three steps**, naming each call instead of each write.

The flow, in order:

```ts
// 1. Report the call you are about to make. toolCallId is yours, and unique within the discussion.
await client.mutation.upsertDiscussionToolCall({
  input: { discussionId, toolCallId: "reply-1", status: "PENDING", text: "Reply to the customer: We refunded…" },
});

// 2. Ask. Idempotent by toolCallId: asking twice returns the same approval, so a retry is safe.
await client.mutation.requestDiscussionToolCallApproval({
  input: { discussionId, toolCallId: "reply-1", justification: "I drafted an answer and believe it is ready." },
});

// 3. Poll the discussion's messages for the approval entry. There is no webhook for this yet.
const page = await (await client.query.discussion({ discussionId })).messages({ last: 50 });
```

The entry you are looking for:

```graphql
type ThreadDiscussionToolCallApprovalEntryPayload {
  approvalId: ID!
  toolCallId: ID!               # the call this gates, unique among the discussion's approvals
  justification: String!
  status: AgentApprovalStatus!  # PENDING | APPROVED | DENIED
  reviewerNote: String          # what the reviewer typed; on DENIED it becomes the call's error
  resolvedAt: DateTime
  resolvedBy: InternalActor
}
```

**On `APPROVED`**, run the call, then report the real outcome with `upsertDiscussionToolCall` and
`SUCCESS` or `ERROR`. Leaving it `PENDING` leaves the timeline saying the call never finished.

**If you give up waiting, close the card.** This example waits 15 minutes and then reports the call as
`ERROR` with "no decision within 15 minutes, this draft was discarded". Leaving it open instead is worse
than it sounds: the card stays actionable, so a reviewer arriving late reads the draft, clicks Approve,
watches the card turn `APPROVED`, and is never told that nothing was sent.

**On `DENIED`, do not run it.** Feed `reviewerNote` back to the model as the result and let it try again.
A second attempt needs a **new `toolCallId`**: one approval gates one call, and a decided card is never
reopened. Do not report `ERROR` on the denied call either; Plain has already set its error to the note.

**Make the card decidable on its own.** The reviewer sees `text` as the heading and `justification`
underneath, and usually nothing else, so `text` should name the action and preview the content
("Reply to the customer: <first 200 characters>"), and `justification` should say why you think it is
ready. `service`, `op` and `args` are **not** settable by an agent, so they are null on your calls and
the card shows no argument block. That is expected.

**Do not touch `agentStatus` while a card is open.** Plain moves the discussion into its approval-pending
state itself when you request the approval, and it refuses `IDLE` and `IN_PROGRESS` while the card stands.
**Never set `TOOL_CALL_APPROVAL_PENDING` yourself.**

Which brings up the one thing to get right on reads:

**`agentStatus` reports `NEEDS_INPUT` for a discussion waiting on an approval today, and will report
`TOOL_CALL_APPROVAL_PENDING` once the rename ships.** Both names mean the same state. Accept both. If you
`switch` on the enum, handle both arms, and give the switch a `default` unless you want the next enum
addition to stop your build.

## Gotchas

**Pin the webhook target to `2026-08-19` or later.** `discussion.message_created` was added in that
version. A target on an older one is silently never sent the event, and nothing anywhere reports an
error.

**Return 200 immediately, then work.** Plain retries anything that is not a 2xx, and a real answer
takes far longer than the delivery timeout. Answer the HTTP request first, do the work after.

**Deduplicate on `message.id`.** A retried delivery must not produce a second answer.

**Keep one model session per discussion, not per message.** Store the discussion id against whatever
session handle your model gives you and resume it on the next turn, or every message starts from
nothing and the conversation has no memory.

**Both the SDK and raw HTTP default to the UK API,
`https://core-api.uk.plain.com/graphql/v1`.** Pass `apiUrl` if your workspace is elsewhere.

**The SDK asks for Node 24+.** It runs fine on Bun 1.2.10, which is what this project uses.
