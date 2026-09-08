# example-aisdk-agent

Both of Plain's agent surfaces, built directly on the [Vercel AI SDK](https://ai-sdk.dev) with no
framework in between. The lowest-level of the three packages here, and the only one that does both
surfaces, so it is the place to compare them.

For the other shapes see the [repo README](../../README.md). The protocol itself is documented at
[Build a support agent](https://www.plain.com/docs/agents/support-agent) and
[Build an internal agent](https://www.plain.com/docs/agents/internal-agent).

## The two surfaces

| | Support agent | Internal agent |
| --- | --- | --- |
| Where it works | a customer thread | a Sidekick discussion |
| Who reads it | the customer | your own team |
| Events | `thread.*` | `discussion.*` |
| Entry point | `src/support.ts` | `src/internal.ts` |
| The model's tools | Plain mutations it chooses | one mocked action |
| The human gate | draft instead of send | an approval card |

Both call one shared core, `src/core.ts`, which knows nothing about Plain: it takes a system
prompt, a user prompt and a tool set, and runs the model. Everything Plain-specific lives in the
two entry points and in `src/plain.ts`.

**The gates are the interesting difference.** They are the same principle, a person decides before
anything irreversible happens, expressed two ways because the surfaces offer different mechanisms:

- **On a thread there is no approval card**, so the gate is the choice of mutation.
  `replyToThread` reaches the customer; `addGeneratedReply` drafts for a person to review, edit and
  send. Gated is the default, so the model's answer becomes a suggestion.
- **In a discussion there is a card**, so the gate is the real thing: report the call with
  `upsertDiscussionToolCall`, ask with `requestDiscussionToolCallApproval`, and wait.

Both are on by default. `PLAIN_GATE_SUPPORT=0` and `PLAIN_GATE_INTERNAL=0` turn them off, and an
example that shipped them off would teach nothing about the part that is actually hard.

## Deciding what to act on

**The support agent acts only on threads assigned to its machine user.** That is the pattern the
docs recommend: the decision lives in Plain, so a workflow or a person can change it without a
deploy, and your reporting attributes the work to the agent the way it would to a person. An
unassigned thread is not this agent's problem.

**The internal agent answers only when all four conditions hold**: `discussion.type` is
`AGENT_SESSION`, `discussion.agent.id` is this machine user, `message.type` is `OUTBOUND`, and the
discussion is not `RESOLVED`. The message type check is the loop guard, because the agent's own
replies come back as `INBOUND`.

Those decisions are pure functions in `src/serve.ts` and are the part of this package covered by
tests, since they need no credentials to exercise.

## Reading the thread

`src/plain.ts` paginates `timelineEntries` and concatenates `llmText`, which is Plain's own
rendering of a timeline entry for a language model. Entries with nothing to render return null and
are skipped. That is the whole thread-reading strategy, and it is deliberately not a custom
formatter.

## Setting it up

```bash
cd packages/example-aisdk-agent
bun install
cp .env.example .env
```

Fill in `PLAIN_API_KEY`, `PLAIN_WEBHOOK_SECRET` and `ANTHROPIC_API_KEY`. **Unlike the other two
packages this one holds a model key**, because it calls the model itself rather than driving a CLI
you have already logged in or a framework that brokers it.

Permissions differ by surface. The support surface needs `thread:read`, `thread:reply`,
`generatedReply:create`, `thread:assign`, `thread:unassign` and `customer:read`. The internal
surface needs `threadDiscussion:read`, `threadDiscussion:edit`, `threadDiscussionMessage:create`
and `threadDiscussionMessage:edit`.

```bash
bun run help      # the commands and what .env is missing
bun run check     # who the key is, which events to subscribe, whether the model is reachable
bun run serve
```

`bun run check` prints the exact event list for each surface. Webhook targets need version
`2026-09-06`, matching `@team-plain/webhooks` 1.9.0. A mismatch is not obvious from the outside:
Plain delivers, the server answers 401, and nothing moves.

Run one surface at a time with `PLAIN_SURFACE_SUPPORT=0` or `PLAIN_SURFACE_INTERNAL=0`. Both are on
by default here, which a real agent would usually not do.

## Why generateText and not streamText

Nothing consumes a stream. Both surfaces post one finished message to Plain, so streaming would
only add a buffer to collect the text back into a string. `stopWhen: stepCountIs(8)` bounds the
tool loop; without a stop condition the SDK takes a single step, so a tool call would be requested
and never answered.

## What has not been verified

**No live turn has run on either surface.** Typecheck is clean, and the routing and answer-or-ignore
decisions are covered by tests. What has not happened is a real webhook, a real thread read, a real
reply or suggestion, a real Ask Sidekick conversation, or a real approval card. That needs a machine
user with the right permissions and a model key. Treat the wiring as reviewed, not proven.
