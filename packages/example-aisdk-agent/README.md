# example-aisdk-agent

Both of Plain's agent surfaces, built straight on the [Vercel AI SDK](https://ai-sdk.dev) with no
framework in between. The lowest-level of the three packages, and the only one that does both
surfaces, so it is where you can put them side by side.

For the other shapes see the [repo README](../../README.md). The protocol is documented at
[Build a support agent](https://www.plain.com/docs/agents/support-agent) and
[Build an internal agent](https://www.plain.com/docs/agents/internal-agent).

## How it works

```
                              ┌──────────────────────────┐
   thread.* webhooks  ──────> │  src/support.ts          │ ──> replyToThread
   (customer threads)         │  a customer thread       │     addGeneratedReply
                              └────────────┬─────────────┘     createNote, addLabels
                                           │
                                    ┌──────┴──────┐
                                    │ src/core.ts │  one model call, knows nothing about Plain
                                    └──────┬──────┘
                                           │
                              ┌────────────┴─────────────┐
   discussion.* webhooks ───> │  src/internal.ts         │ ──> sendDiscussionMessage
   (Ask Sidekick)             │  a Sidekick discussion   │     upsertDiscussionToolCall
                              └──────────────────────────┘     requestApproval
```

`src/core.ts` takes a system prompt, a user prompt and a tool set, and runs the model. Everything
Plain-specific lives in the two entry points and in `src/plain.ts`.

| | Support agent | Internal agent |
| --- | --- | --- |
| Where it works | a customer thread | a Sidekick discussion |
| Who reads it | the customer | your own team |
| Events | `thread.*` | `discussion.*` |
| Entry point | `src/support.ts` | `src/internal.ts` |
| The model's tools | Plain mutations it chooses | one mocked action |
| The human gate | draft instead of send | an approval card |

Written in TypeScript, run with [Bun](https://bun.sh). Unlike the other two packages this one holds
a model key, because it calls the model itself rather than driving a CLI you have already logged in
or a framework that brokers it for you.

## Setting it up

1. Create a machine user under [Settings → Machine users](https://app.plain.com/~/settings/machine-users/)
   and give it an API key. Turn the "Custom agent" toggle on.

   The two surfaces want different permissions. The support surface needs `thread:read`,
   `thread:reply`, `generatedReply:create`, `thread:assign`, `thread:unassign` and `customer:read`.
   The internal surface needs `threadDiscussion:read`, `threadDiscussion:edit`,
   `threadDiscussionMessage:create` and `threadDiscussionMessage:edit`.

2. Copy `.env.example` to `.env` in this directory and fill in `PLAIN_API_KEY`,
   `PLAIN_WEBHOOK_SECRET` from
   [Settings → Request Signing](https://app.plain.com/~/settings/request-signing/), and
   `OPENAI_API_KEY`.

3. Get a public https URL that reaches this process. Locally, `ngrok http 8082`.

4. Create the webhook under
   [Settings → Webhooks → Add webhook target](https://app.plain.com/~/settings/webhooks/add/),
   pointed at `$PUBLIC_URL/plain/webhook` on version `2026-09-06`.

   `bun run check` prints the exact event list for whichever surfaces you are running, so create the
   target after running it rather than guessing.

## Running it

```
bun install
bun run help      # the commands and what .env is still missing
bun run check     # who the key is, which events to subscribe, whether the model is reachable
bun run serve
```

Both surfaces are on by default, because comparing them is the point of this package. A real agent
would usually run one: `PLAIN_SURFACE_SUPPORT=0` or `PLAIN_SURFACE_INTERNAL=0`.

The system prompts are `prompts/support.md` and `prompts/internal.md`, read fresh on startup.

The server logs every delivery it receives and says what it skipped and why. That matters more than
it sounds: an earlier version dropped deliveries in silence, and a turn that ran perfectly looked
identical to one that never started.

### The internal surface

Open a thread in Plain, click Ask Sidekick, pick your agent, and ask something. Each turn runs
`IN_PROGRESS`, posts the answer, then settles `IDLE`.

### The support surface

This one triggers on thread events rather than a person's message, so the order you do things in
matters:

```
create a thread  ->  a customer message arrives  ->  assign the thread to the machine user
```

Assign first and the agent runs before there is anything to read, then correctly reports that it
took no action. The customer message has to exist before the agent gets the thread.

**The agent acts only on threads assigned to its machine user.** That is the pattern the docs
recommend: the decision lives in Plain, so a workflow or a person can change it without a deploy,
and your reporting attributes the work to the agent the way it would to a person. An unassigned
thread is somebody else's problem.

Note that handing off unassigns the thread, so the next event on it is no longer the agent's to act
on. That is deliberate, and it surprised me the first time.

## Reading the thread

`src/plain.ts` paginates `timelineEntries` and concatenates `llmText`, which is Plain's own
rendering of a timeline entry for a language model. Entries with nothing to render come back null
and are skipped. That is the entire thread-reading strategy, and deliberately not a custom
formatter.

## Webhook version, the one setting that silently wastes an afternoon

**`@team-plain/webhooks` pins exactly one webhook target version.** Not a minimum: a target set
**newer** than the package fails just as hard as one set older.

| `@team-plain/webhooks` | required target version |
| --- | --- |
| 1.7.1 | `2026-08-19` |
| 1.8.0 | `2026-08-31` |
| 1.9.0 | `2026-09-06` (what this example uses) |

A mismatch does not look like a version problem. Plain delivers, your server answers **401**, and the
discussion sits on "thinking" forever. Only your own log says why. Change both together.

## Approving what the agent does

Both surfaces gate the agent before anything irreversible happens. They express the same idea two
different ways, because Plain gives them different mechanisms.

**On a thread there is no approval card**, so the gate is the choice of mutation. `replyToThread`
reaches the customer. `addGeneratedReply` saves a draft for a person to review, edit and send, and
the customer sees nothing until someone sends it. Drafting is the default.

Three things about that draft path took a real run to get right:

The event that hands a thread to the agent is usually an assignment, which carries no message of its
own, and `addGeneratedReply` needs a customer message to attach to. So the agent looks up the newest
customer entry itself. Without that, a gated reply could never attach anything.

The tool result says plainly that a draft is success. An earlier version returned `sent: false`, and
the model read that as failure, apologised for a "system issue" and handed off.

After drafting, the thread hands off. Only `HANDED_OFF` threads appear in the human queues, so a
draft left `IN_PROGRESS` is a draft nobody will ever see.

**In a discussion there is a card**, so the gate is the real thing: report the call with
`upsertDiscussionToolCall`, ask with `requestDiscussionToolCallApproval`, and wait. `page_oncall` is
mocked; the gate around it is not.

`PLAIN_GATE_SUPPORT=0` and `PLAIN_GATE_INTERNAL=0` turn them off. Both are on by default, because an
example that shipped the gate switched off would teach nothing about the part that is actually hard.

**Only a person can resolve a card.** `resolveDiscussionApproval` refuses a machine user with
"Machine user not allowed to perform this operation", even for the agent's own request. While a card
is open Plain also refuses any agent status change, so the code skips that write instead of
attempting it: an unchecked failure there crashed the whole turn.

## Why generateText and not streamText

Nothing here consumes a stream. Both surfaces post one finished message to Plain, so streaming would
only add a buffer to collect the text back into a string. `stopWhen: stepCountIs(8)` bounds the tool
loop, and without a stop condition the SDK takes a single step, so a tool call would be requested and
never answered.

The default model is `gpt-4o-mini`. A reasoning model is a poor fit here: `gpt-5-mini` returned empty
content on a small output budget, which reads as a broken agent rather than a thinking one.
`AGENT_MODEL` overrides it.

## Building your own

Both docs pages have the payloads, every API call and the gotchas, so you can implement either
surface in any language:
[support agent](https://www.plain.com/docs/agents/support-agent),
[internal agent](https://www.plain.com/docs/agents/internal-agent).

## What has been verified, and what has not

The support surface has run end to end against a live workspace: a real customer message, a real
assignment, a real thread read, a drafted reply, and the handoff that puts it in a human queue. The
internal surface has answered a real question in a real discussion and settled `IDLE`, and its
approval gate has reached `TOOL_CALL_APPROVAL_PENDING` with the agent's own justification on the
card.

What has not run is a webhook-driven internal turn, because that needs a person to send an Ask
Sidekick message: a message the machine user creates through the API comes back `INBOUND`, and the
agent answers only `OUTBOUND`. Nor has an approved or denied card been seen through to the other
side, for the reason above.
