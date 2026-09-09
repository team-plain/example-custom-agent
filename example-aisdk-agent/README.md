# example-aisdk-agent

A Plain agent built straight on the [Vercel AI SDK](https://ai-sdk.dev), with no framework in
between. Every Plain call is written out where you can read it, which makes this the better of the
two packages for understanding the protocol rather than a framework.

For the other shape see the [repo README](../README.md). The protocol is documented at
[Build an internal agent](https://www.plain.com/docs/agents/internal-agent) and
[Build a support agent](https://www.plain.com/docs/agents/support-agent).

## How it works

A teammate opens Ask Sidekick and asks the agent to handle a customer. The discussion may be
attached to their thread, or to nothing at all.

```
                       discussion.message_created
   Plain  ──────────────────────────────────────────>  src/serve.ts
                                                            │
                                                       src/agent.ts
                                                            │
     ┌──────────────────┬──────────────────┬──────────────────┬──────────────────┐
 list_thread_queue  search_threads  read_customer_thread  search_knowledge  reply_to_customer
 threads()          searchThreads() threadAsText()   searchKnowledgeSources() APPROVAL, then
     │                  │                  │                  │            replyToThread()
     └──────────────────┴──────────────────┴──────────────────┴──────────────────┘
                                         │
                              upsertDiscussionToolCall
                              PENDING before, settled after
```

`src/core.ts` takes a system prompt, a user prompt and a tool set, and runs the model. It knows
nothing about Plain. Everything Plain-specific is in `src/agent.ts` and `src/plain.ts`.

| File | What it holds |
| --- | --- |
| `src/serve.ts` | the webhook server, signature check, and which deliveries to act on |
| `src/agent.ts` | the five tools, the reachable-thread set, the approval wait, and the turn |
| `src/plain.ts` | every Plain query and mutation |
| `src/core.ts` | the model call, and nothing else |
| `prompts/agent.md` | the system prompt, read fresh on startup |

Written in TypeScript, run with [Bun](https://bun.sh). This package holds a model key, because it
calls the model itself rather than driving a framework that brokers it for you.

## Setting it up

1. Create a machine user under [Settings → Machine users](https://app.plain.com/~/settings/machine-users/)
   and give it an API key. Turn the "Custom agent" toggle on, or it never appears in the picker
   when someone opens Ask Sidekick.

   Permissions: `threadDiscussion:read`, `threadDiscussion:edit`,
   `threadDiscussionMessage:create`, `threadDiscussionMessage:edit`, `thread:read` and
   `thread:reply`. The last two are what let it read the customer's conversation and answer on it.

2. Copy `.env.example` to `.env` in this directory and fill in `PLAIN_API_KEY`,
   `PLAIN_WEBHOOK_SECRET` from
   [Settings → Request Signing](https://app.plain.com/~/settings/request-signing/), and
   `OPENAI_API_KEY`.

3. Get a public https URL that reaches this process. Locally, `ngrok http 8082`.

4. Create the webhook under
   [Settings → Webhooks → Add webhook target](https://app.plain.com/~/settings/webhooks/add/),
   pointed at `$PUBLIC_URL/plain/webhook` on version `2026-09-06`, subscribed to
   `discussion.message_created` and `discussion.tool_call_approval_resolved`.

   `bun run check` prints the exact event list, so create the target after running it rather than
   guessing.

## Running it

```
bun install
bun run help      # the commands and what .env is still missing
bun run check     # identity, events, model, and whether anything is indexed to search
bun run serve
```

Then open a thread in Plain, click Ask Sidekick, pick your agent, and ask it to answer the customer.
Or open Ask Sidekick on nothing and ask it what is in the queue: it will search and find its own way
to a thread.

**Run `check` before your first turn and read the knowledge line.** An agent with nothing indexed
searches successfully and finds nothing, which looks like a broken agent rather than an empty help
center. `check` tells you how many results a sample query gets.

The server logs every delivery and says what it skipped and why. An earlier version dropped
deliveries in silence, and a turn that ran perfectly looked identical to one that never started.

## The tools

**`list_thread_queue`** and **`search_threads`** find a thread the discussion was not opened on.
Plain does not always attach one, and without these a threadless Sidekick session has nothing to
work with. Every id they return becomes reachable for the rest of the turn.

**`read_customer_thread`** paginates `timelineEntries` and concatenates `llmText`, which is Plain's
own rendering of a timeline entry for a language model. Entries with nothing to render come back
null and are skipped. That is the whole thread-reading strategy, and deliberately not a custom
formatter.

**`search_knowledge`** calls `searchKnowledgeSources`, so Plain does the retrieval and this package
ships no vector store. It is scoped with `options: { types: ["HELP_CENTER_ARTICLE"] }`, which
matters more than it looks: a workspace with its own product docs indexed as documents will see
those outrank the help center on any query sharing a word with them, and the agent then answers
confidently about the wrong product.

**`reply_to_customer`** is the only call a customer ever sees, and the only one gated. It reports
the call, asks for approval, waits, and on approval calls `replyToThread` on the parent thread.

Both reads report themselves on the discussion timeline: `PENDING` before the work, `SUCCESS` or
`ERROR` after. That is what makes the team able to watch the agent work.

## Approving the reply

There is no environment variable to switch the gate off, on purpose. Everything else the agent does
is a read.

The card leads with **who receives the reply and on which thread**, then the full draft. That order
is deliberate: the agent can reply to a thread it found in the queue, so the wrong customer is now a
possible mistake and the card is where it gets caught. `cardText` is the one function that decides
this, and a test pins the ordering.

The draft goes on in full rather than as a summary, because nobody can approve a reply they cannot
read. A denial comes back to the model with the reviewer's note attached, and the tool result says
in words that a person declined and not to resend the same text. That phrasing is load-bearing: an
earlier version returned a bare `sent: false`, and the model read it as a system fault and
apologised to the teammate for a problem that had not happened.

**Only a person can resolve a card.** `resolveDiscussionApproval` refuses a machine user with
"Machine user not allowed to perform this operation", even for the agent's own request. While a card
is open Plain also refuses any agent status change, so the code skips that write instead of
attempting it: an unchecked failure there crashed the whole turn.

If nobody decides within five minutes the agent stops waiting, fails the call so it stops reading
as still running, and leaves the card open, because only a person can close it.

## Which threads a turn may touch

`serve.ts` reads `discussion.threadId` off the webhook payload, and `agentTools` seeds a per-turn
`Set` with it. `list_thread_queue` and `search_threads` add every id they return. `read_customer_thread`
and `reply_to_customer` refuse anything not in that set.

The set exists because the queue tools changed what a thread id is. It used to arrive only from a
webhook, in a closure the model could not reach. Now the model types one back, so it is model
output, and a thread id sitting in text the agent read is not authority to act on it.

**Per turn, not per process.** The set is built inside `agentTools`, so it dies when the turn does
and what one discussion discovered is not another's to act on. `example-eve-agent` cannot do this,
because an eve tool is a standalone file with no turn context, and its README says so.

`threadId` is nullable. A discussion opened on nothing is not a dead end any more: the prompt points
the model at the queue instead.

## Webhook version, the one setting that silently wastes an afternoon

**`@team-plain/webhooks` pins exactly one webhook target version.** Not a minimum: a target set
**newer** than the package fails just as hard as one set older.

| `@team-plain/webhooks` | required target version |
| --- | --- |
| 1.7.1 | `2026-08-19` |
| 1.8.0 | `2026-08-31` |
| 1.9.0 | `2026-09-06` (what this example uses) |

A mismatch does not look like a version problem. Plain delivers, your server answers **401**, and
the discussion sits on "thinking" forever. Only your own log says why. Change both together.

## Why generateText and not streamText

Nothing here consumes a stream. The turn posts one finished message to Plain, so streaming would
only add a buffer to collect the text back into a string. The progressive part of this agent is the
tool calls on the timeline, not the tokens.

`stopWhen: stepCountIs(8)` bounds the tool loop. Without a stop condition the SDK takes a single
step, so a tool call would be requested and never answered.

The default model is `gpt-4o-mini`. A reasoning model is a poor fit here: `gpt-5-mini` returned
empty content on a small output budget, which reads as a broken agent rather than a thinking one.
`AGENT_MODEL` overrides it.

## .env reads over the shell

`loadDotEnv` reads this package's `.env` **over the top** of the real environment, and it is
anchored to the package rather than the working directory.

That is the opposite of what Bun does by default, and deliberately so. An exported `PLAIN_API_KEY`
left in a shell otherwise wins and runs the agent as a different machine user against a different
workspace. The failure that produces is an agent that searches successfully and answers about the
wrong product, which is a long way from looking like a credential problem.

## What has been verified, and what has not

Against a live workspace: the machine user identity, the event list, the knowledge search returning
real articles, the queue and thread search, and a full model turn on a **threadless** discussion
that searched the queue, found the right thread, read it, searched the help center, grounded its
answer in an article, and produced a card naming the customer by name.

What has not run is a webhook-driven turn, because that needs a person to open Ask Sidekick: a
discussion of type `AGENT_SESSION` cannot be created through the API at all, and a message the
machine user creates comes back `INBOUND` while the agent answers only `OUTBOUND`. An approval seen
through to approved or denied has not run either, for the reason above.
