# example-eve-agent

An internal Plain agent built on [eve](https://eve.dev/docs), Vercel's filesystem-first agent
framework. An agent here is a directory: a system prompt, a model config, one file per tool, and one
file per channel.

Reach for this one when you want durable sessions and a model loop you do not have to write. For the
other two shapes see the [repo README](../../README.md), and for the protocol this implements see
[Build an internal agent](https://www.plain.com/docs/agents/internal-agent).

## How it works

```
┌─────────────────────┐  discussion.message_created  ┌──────────────────────────────┐
│        Plain        │ ───────────────────────────> │  agent/channels/plain.ts     │
│     Ask Sidekick    │                              │  POST /plain/webhook         │
│                     │ <─────────────────────────── │  from(discussion.id).send()  │
└─────────────────────┘    the event handlers write   └──────────────┬───────────────┘
                                                                     │
                                                          one eve session
                                                          per discussion
```

`from(discussion.id).send()` is the whole mapping between a Plain discussion and an eve session. eve
creates the session on the first message and resumes it on every later one, so this package has no
session store and no resume id to keep track of. That is most of why it is shorter than
`example-coding-agent`.

Every write back to Plain lives in the channel's `events`:

| eve channel event | What this package does |
| --- | --- |
| `turn.started` | `updateDiscussionAgentStatus(IN_PROGRESS)` |
| `actions.requested` | `upsertDiscussionToolCall(PENDING)`, one per call |
| `input.requested` | `requestDiscussionToolCallApproval`, for `tool-approval` only |
| `action.result` | `upsertDiscussionToolCall(SUCCESS or ERROR)` |
| `message.completed` | `sendDiscussionMessage` |
| `session.waiting` | `updateDiscussionAgentStatus(IDLE)` |
| `turn.failed`, `session.failed` | post the failure, then `IDLE` |

The status settles last on purpose. Posting the reply is what marks the discussion unread, so
settling first would claim the agent had finished before its answer existed.

Written in TypeScript, run on Node 24 with npm. Read the next section before you run anything.

## This package is npm and Node 24, and lives outside the Bun workspace

Every other package here is Bun. This one cannot be, and the reasons are worth knowing because you
will hit all three:

- The eve CLI refuses to run under Bun. `bun x eve --version` answers
  `eve requires Node.js >=24. You are running v22.22.3`.
- eve pins TypeScript 7 where the Bun packages use 5. One `node_modules` cannot hoist both.
- eve ships `package-lock.json`, and a Bun workspace keeps a single root `bun.lock`.

So `bun install` at the repo root does not cover this directory, and the root `workspaces` list
names packages one by one instead of globbing, because Bun ignores a negated pattern.

**Every npm command here needs `--no-workspaces`.** Leave it off and npm walks up, finds the repo
root's `package.json`, and installs against that instead:

```bash
cd packages/example-eve-agent
npm install --no-workspaces
npm run typecheck --no-workspaces
```

`eve` is pinned to an exact version rather than a caret. It is 0.x and in public beta, and its own
terms say the APIs may change before general availability, so bump it deliberately and re-read
`node_modules/eve/docs` when you do. That directory is where eve's real documentation lives, all 105
files of it.

## Setting it up

1. Create a machine user under [Settings → Machine users](https://app.plain.com/~/settings/machine-users/)
   and give it an API key.

   Turn the "Custom agent" toggle on, or it never appears in the picker when someone opens Ask
   Sidekick.

   Permissions: `threadDiscussion:read`, `threadDiscussion:edit`,
   `threadDiscussionMessage:create`, `threadDiscussionMessage:edit`.

2. Copy `.env.example` to `.env` in this directory.

   ```
   cd packages/example-eve-agent
   cp .env.example .env
   ```

   Fill in `PLAIN_API_KEY`, `PLAIN_WEBHOOK_SECRET` from
   [Settings → Request Signing](https://app.plain.com/~/settings/request-signing/), and
   `AI_GATEWAY_API_KEY`.

3. Get a public https URL that reaches this process. Locally, `ngrok http <port>` against whatever
   port `eve dev` prints.

4. Create the webhook under
   [Settings → Webhooks → Add webhook target](https://app.plain.com/~/settings/webhooks/add/).

   Pointed at `$PUBLIC_URL/plain/webhook`, on version `2026-09-06`, subscribed to
   `discussion.message_created` **and** `discussion.tool_call_approval_resolved`. The second one is
   how a turn parked on an approval gets resumed.

## Running it

Before touching webhooks, watch a turn happen on its own. This is the fastest way to know your
gateway key and model work:

```
npm ci --no-workspaces
npm run typecheck --no-workspaces
npm test --no-workspaces
npx --no-install eve invoke "In one short sentence, what is a webhook?"
```

Then the real thing:

```
npm run dev --no-workspaces
```

Open a thread in Plain, click Ask Sidekick, pick your agent, and ask it something.

`npm run build --no-workspaces` is worth running too, and not only in CI. eve discovers channels by
filename, so a single stray file in `agent/channels/` fails the whole build. A test file in there
once broke it with `Channel path segment "plain.smoke.test" is not a legal channel name` while
typecheck and the unit tests both passed happily. Tests live in `tests/` for that reason.

The system prompt is `agent/instructions.md`. Edit it to change what the agent is and what it will
do.

## The model

`agent/agent.ts` uses `anthropic/claude-haiku-4.5`, a string model id routed through the Vercel AI
Gateway, which needs `AI_GATEWAY_API_KEY` or a `VERCEL_OIDC_TOKEN` that `eve link` pulls from a
Vercel project. Haiku is the default because this example is meant to be run over and over without
anyone thinking about cost.

Watch the exact id. `anthropic/claude-3-5-haiku` is not served by the gateway and returns a 404.

To skip the gateway, install a provider package such as `@ai-sdk/openai`, set that provider's key,
and pass its model object in `agent/agent.ts` instead of the string.

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

`agent/tools/page_oncall.ts` is gated with `always()` from `eve/tools/approval`, so the model cannot
run it without a person agreeing first. The paging itself is mocked, since this example ships no
pager credential. The gate around it is real, and that is the part worth copying.

The two protocols line up almost exactly, which is what makes this a good place to see the flow:

1. The model calls the tool. eve parks the turn durably and emits `input.requested`.
2. The channel reports the call to Plain and asks for approval. Plain shows a card and moves the
   discussion to `TOOL_CALL_APPROVAL_PENDING`.
3. A person approves or denies, and Plain sends `discussion.tool_call_approval_resolved`.
4. The channel answers the parked request with `respond()`, and eve picks the turn back up where it
   left off.

`requestId` is the only thing joining the two sides, which is why the channel records the Plain
`toolCallId` against it when the request arrives. The approval options eve offers are `approve` and
`cancel`.

Two things about this that are easy to get wrong, and both were:

**On a denial the channel writes nothing further.** Plain has already failed that call with the
reviewer's note as its error, and eve reports the result as `rejected`, so a second write would only
replace a person's reason with a worse one.

**While a card is open, the agent cannot report a status at all.** Plain rejects it with
`agentStatus cannot be reported while an approval is open on this discussion`, and only
`resolveDiscussionApproval` closes a card. A machine user is not allowed to call that, so an
unanswered card cannot be cleared by the agent under any circumstances. `session.waiting` skips the
`IDLE` write while one is open rather than attempting it and failing.

## Building your own

[Build an internal agent](https://www.plain.com/docs/agents/internal-agent) has the webhook
payloads, every API call and the gotchas, so you can implement this in any language.
[Build a support agent](https://www.plain.com/docs/agents/support-agent) is the other surface, an
agent on customer threads rather than an internal Sidekick conversation.

## What has not been verified

No live webhook has driven this package end to end. The eve runtime, the model through the gateway,
the gated tool parking a turn, the build and 21 unit tests all pass, and the channel module has a
test that imports it for real. What has not happened is a real `discussion.message_created` arriving
and the event handlers writing status, reply and tool calls back to Plain.

That step needs a person to send an Ask Sidekick message, because a message the machine user creates
through the API comes back as `INBOUND` and this agent answers only `OUTBOUND`. Treat the wiring as
reviewed rather than proven.
