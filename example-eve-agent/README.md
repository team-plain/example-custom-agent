# example-eve-agent

A Plain agent built on [eve](https://eve.dev/docs), Vercel's agent framework.

The protocol with the Plain API & webhooks is documented [here](https://www.plain.com/docs/agents/internal-agent).

## How it works

A teammate opens Ask Sidekick and asks the agent to handle a customer.

```
┌─────────────────────┐  discussion.message_created  ┌──────────────────────────────┐
│        Plain        │ ───────────────────────────> │  agent/channels/plain.ts     │
│     Ask Sidekick    │                              │  POST /plain/webhook         │
│                     │ <─────────────────────────── │  from(discussion.id).send()  │
└─────────────────────┘    the event handlers write   └──────────────┬───────────────┘
                                                                     │
                                                          one eve session
                                                          per discussion
                                                                     │
          ┌──────────────────┬──────────────────┬──────────────────┬──────────────────┐
     list_thread_queue  search_threads  read_customer_thread  search_knowledge  reply_to_customer
                                                                              approval: always()
```

The discussion may be attached to a customer thread or to nothing at all. The queue tools are what
make the second case useful rather than a dead end.

`from(discussion.id).send()` is the whole mapping between a Plain discussion and an eve session. eve
creates the session on the first message and resumes it on every later one, so this package has no
session store and no resume id to track.

**That resume is also this package's memory**, and it is the one place eve saves you real work. The
AI SDK package has to read the discussion's messages back out of Plain and rebuild a `messages`
array every turn; here the durable session already holds it. Get this wrong and the symptom is not
an error: the agent answers each message as if it were the first, so "the thread you just replied
to" has no referent and it picks one rather than asking.

Every write back to Plain lives in the channel's `events`, not in the tools:

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

The other package here is Bun. This one cannot be, and the reasons are worth knowing because you
will hit all three:

- The eve CLI refuses to run under Bun. `bun x eve --version` answers
  `eve requires Node.js >=24. You are running v22.22.3`.
- eve pins TypeScript 7 where the Bun package uses 5. One `node_modules` cannot hoist both.
- eve ships `package-lock.json`, and a Bun workspace keeps a single root `bun.lock`.

So `bun install` at the repo root does not cover this directory, and the root `workspaces` list
names the package explicitly instead of globbing, because Bun ignores a negated pattern.

**Every npm command here needs `--no-workspaces`.** Leave it off and npm walks up, finds the repo
root's `package.json`, and installs against that instead:

```bash
cd example-eve-agent
nvm use                    # reads .nvmrc, which pins 24
npm install --no-workspaces
npm run typecheck --no-workspaces
```

`nvm use` is the step people skip. Every command here, `npm test` included, dies on
`eve requires Node.js >=24` if your shell default is older, and `bun run` in this directory hits the
same wall: `.nvmrc` records the version but nothing applies it for you.

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
   `threadDiscussionMessage:create`, `threadDiscussionMessage:edit`, `thread:read` and
   `thread:reply`. The last two are what let it read the customer's conversation and answer on it.

2. Copy `.env.example` to `.env` in this directory.

   ```
   cd example-eve-agent
   cp .env.example .env
   ```

   Fill in `PLAIN_API_KEY`, `PLAIN_WEBHOOK_SECRET` from
   [Settings → Request Signing](https://app.plain.com/~/settings/request-signing/), and
   `AI_GATEWAY_API_KEY`.

3. Get a public https URL that reaches this process. Locally, `ngrok http 8082`.

   Both packages serve `/plain/webhook` on port 8082, so one tunnel and one webhook target work for
   either of them. Run one at a time: the second fails with `EADDRINUSE`, which is why the scripts
   pass `--host 0.0.0.0`. Bound to loopback instead, eve would start alongside the other agent and
   quietly take its deliveries.

4. Create the webhook under
   [Settings → Webhooks → Add webhook target](https://app.plain.com/~/settings/webhooks/add/).

   Pointed at `$PUBLIC_URL/plain/webhook`, on version `2026-09-06`, subscribed to
   `discussion.message_created` **and** `discussion.tool_call_approval_resolved`. The second one is
   how a turn parked on an approval gets resumed.

## Running it

Before touching webhooks, watch a turn happen on its own. This is the fastest way to know your
gateway key, your model and your knowledge base all work:

```
nvm use
npm ci --no-workspaces
npm run typecheck --no-workspaces
npm test --no-workspaces
npx --no-install eve invoke "A customer asks what counts as a task on the Team plan. Search the knowledge base. There is no customer thread here, so do not read one or reply."
```

If it answers from your help center and cites an article id, everything downstream of the model is
working. If it says the knowledge base covers a different product, read the `.env` section below
before anything else.

Then the real thing:

```
nvm use
npm run serve --no-workspaces
```

Same script name and same port as the other package, which runs `bun run serve`. Note the runner
differs: this package is npm on Node 24 and the other is Bun, so `bun run serve` here fails on the
version check. `npm run dev
--no-workspaces` is the same server with eve's interactive UI in front of it, useful for talking to
the agent directly and no use for reading webhook logs.

Open a thread in Plain, click Ask Sidekick, pick your agent, and ask it to answer the customer.

`npm run build --no-workspaces` is worth running too, and not only in CI. eve discovers tools and
channels by filename, so a single stray file in either directory fails the whole build. A test file
in `agent/channels/` once broke it with
`Channel path segment "plain.smoke.test" is not a legal channel name` while typecheck and the unit
tests both passed happily. Tests live in `tests/` for that reason.

The system prompt is `agent/instructions.md`.

## The tools

One file each under `agent/tools/`, and the filename is the name the model sees.

**`list_thread_queue`** and **`search_threads`** find a thread the discussion was not opened on.
Both are async generators, so the first `yield` shows the search running on Plain's timeline. Every
id they return becomes reachable, which is the widening that makes the guard below necessary.

Both return a **`url`** per thread, the real `app.plain.com/workspace/.../thread/.../` link, so the
agent can hand a teammate something clickable. The workspace id is looked up once and cached; that
lookup needs a scope not every machine user has, so `url` can be null and `PLAIN_WORKSPACE_ID`
skips it.

**`search_knowledge`** calls `searchKnowledgeSources`, so Plain does the retrieval and this package
ships no vector store. It is an async generator: the first `yield` reaches the channel as an
`action.partial`, so Plain's timeline shows the search running instead of jumping from `PENDING`
straight to a result.

It is scoped with `options: { types: ["HELP_CENTER_ARTICLE"] }`, which matters more than it looks. A
workspace with its own product docs indexed as documents will see those outrank the help center on
any query sharing a word with them, and the agent then answers confidently about the wrong product.

**`read_customer_thread`** concatenates `llmText` from the thread's timeline entries, which is
Plain's own rendering for a language model.

**`reply_to_customer`** carries `approval: always()`. It is the only call a customer ever sees, and
the only one gated.

## Where the thread id comes from, and why the tools check it

This is the sharpest difference from the AI SDK package, and worth understanding before you copy
either.

An eve tool receives its input and a context, but no channel state, so it cannot ask which
discussion it is running for. The thread id therefore travels through the prompt: the channel reads
`discussion.threadId` off the webhook and `promptWithThread` puts it in the message.

Which means the id comes back as **model output**. So `read_customer_thread` and
`reply_to_customer` both check it against `isKnownThread`, the set of ids that a webhook delivered
or a queue tool returned. Without that check, a prompt injected into a customer's thread could name
any thread id and have the agent read it or reply on it.

**The set is process-wide, and that is weaker than it should be.** The AI SDK package builds its
tools per turn and scopes the same set to that turn, so what one discussion discovered cannot be
acted on by another. eve cannot express that here, because a tool is a standalone file with no turn
context. It is the price eve charges for tools that are just files, and worth knowing before you
copy this shape into something with more than one customer's data in it.

**`eve invoke` needs one concession, and it is guarded.** With no webhook, nothing is reachable, so
every local run naming a thread was refused. `trustRequestedThread` accepts an id from the prompt,
but only while `channelHasRun` is false. The moment a real delivery has been handled, the channel is
the sole authority on what was asked, and an id lifted out of a customer's message can never be
trusted that way. Two tests pin both directions.

## Approving the reply

`approval: always()`, not `once()`: every reply is its own decision, and a session that sent one has
not earned the right to send the next unasked. There is no environment variable to switch it off,
because everything else the agent does is a read.

The two protocols line up almost exactly, which is what makes this a good place to see the flow:

1. The model calls the tool. eve parks the turn durably and emits `input.requested`.
2. The channel reports the call to Plain and asks for approval. Plain shows a card and moves the
   discussion to `TOOL_CALL_APPROVAL_PENDING`.
3. A person approves or denies, and Plain sends `discussion.tool_call_approval_resolved`.
4. The channel answers the parked request with `respond()`, and eve picks the turn back up where it
   left off, running the tool body for the first time.

`requestId` is the only thing joining the two sides, which is why the channel records the Plain
`toolCallId` against it when the request arrives. The approval options eve offers are `approve` and
`cancel`.

**The card leads with who receives the reply and on which thread.** eve's own prompt is generic
("Approve tool call: reply_to_customer"), so the channel's `justify` looks the thread up and writes
the customer's name, the thread title and the id above the draft. Since the agent can reply to a
thread it found in the queue, the wrong customer is a real possible mistake and this is where it
gets caught. A failed lookup falls back to the id rather than blocking the gate.

Two things about this that are easy to get wrong, and both were:

**On a denial the channel writes nothing further.** Plain has already failed that call with the
reviewer's note as its error, and eve reports the result as `rejected`, so a second write would only
replace a person's reason with a worse one.

**While a card is open, the agent cannot report a status at all.** Plain rejects it with
`agentStatus cannot be reported while an approval is open on this discussion`, and only
`resolveDiscussionApproval` closes a card. A machine user is not allowed to call that, so an
unanswered card cannot be cleared by the agent under any circumstances. `session.waiting` skips the
`IDLE` write while one is open rather than attempting it and failing.

## .env reads over the shell, and why that had to be added

`agent/lib/client.ts` reads this package's `.env` **over the top** of the inherited environment.

That is not eve's default, and the default cost an hour. An exported `PLAIN_API_KEY` left in a shell
won, so the agent ran as a different machine user against a different workspace and searched a help
center full of a different product's articles. It reported, correctly and confidently, that the
knowledge base did not cover the product it was asked about. Nothing about that looks like a
credential problem.

The file is resolved from `process.cwd()` rather than `import.meta.url`, because eve bundles this
module into `.output` and a module-relative path then resolves inside the build and silently finds
nothing. In a deployed build there is no `.env` at all, so the platform environment stands.

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

## The model

`agent/agent.ts` uses **`anthropic/claude-sonnet-5`**, a string model id routed through the Vercel
AI Gateway, which needs `AI_GATEWAY_API_KEY` or a `VERCEL_OIDC_TOKEN` that `eve link` pulls from a
Vercel project. Both packages use the same model and the same route, so a difference in behaviour
between them is the architecture rather than the model.

Watch the exact id. `anthropic/claude-3-5-haiku` is not served by the gateway and returns a 404, so
check yours against the gateway's model list rather than typing it from memory.

To skip the gateway, install a provider package such as `@ai-sdk/openai`, set that provider's key,
and pass its model object in `agent/agent.ts` instead of the string.

## What has been verified, and what has not

Against a live workspace, through `eve invoke`: the eve runtime, Haiku through the gateway,
`search_knowledge` returning real help center articles and grounding a precise answer in one, and a
full **threadless** run that searched the queue, found the right thread, read it and drafted a
grounded reply. The reachable-thread guard was checked with an invented id and refused it verbatim.
The build and 35 unit tests pass, and the channel module has a test that imports it for real.

All eight behaviour scenarios have run through `eve invoke` on Sonnet: the queue listed with titles
and links and no unsolicited reply, an ambiguous reference asked about rather than guessed, an
invented thread id refused without substituting another, a SOC 2 question left unanswered rather
than turned into a "no", and a colleague's wrong premise caught and questioned. On the planted
prompt injection it drafted only for the thread it was asked about and reported the injection
attempt, naming the thread it had been told to email.

One limit of that harness: `eve invoke` shows an approval request but not its arguments, because the
argument rendering lives in the channel's `justify`. So a scenario that parks on approval is
verified by asking the agent what it would send rather than by reading the parked call.

What has not run is a live webhook driving the channel end to end, so no real
`discussion.message_created` has arrived and no approval has been seen through to approved or
denied. That step needs a person to open Ask Sidekick: a discussion of type `AGENT_SESSION` cannot
be created through the API at all, and a message the machine user creates comes back as `INBOUND`
while this agent answers only `OUTBOUND`. Treat the channel wiring as reviewed rather than proven.
