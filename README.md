# Plain custom agent examples

Reference implementations of one protocol: **Plain sends a webhook, your agent takes a turn, your
agent writes back.** Plain runs the infrastructure around the agent. The AI part, the model, the
prompt and the tools, is yours.

Both packages build the same agent two different ways. They are examples to read and take from,
not a framework to depend on.

The protocol itself lives in Plain's docs rather than in this repo.
[Build a support agent](https://www.plain.com/docs/agents/support-agent) and
[Build an internal agent](https://www.plain.com/docs/agents/internal-agent) give every event and
every API call, so you can build this in a language neither package uses.

## What the agent does

A teammate opens Ask Sidekick on a customer's thread and asks the agent to handle it. From there:

```
read_customer_thread    what did the customer actually ask
search_knowledge        the workspace help center, as many searches as it needs
reply_to_customer       a person approves, then it reaches the customer
```

Every call lands on the discussion timeline as it happens, so the team watches the work instead of
a spinner. The answer is grounded in the help center rather than in the model's memory, and the one
call a customer ever sees is the one call a person decides.

## The packages

| Package | Agent built with | Reach for it when |
| --- | --- | --- |
| [`example-eve-agent`](example-eve-agent) | [Vercel eve](https://github.com/vercel/eve), a filesystem-first agent framework | you want durable sessions, one tool per file, and an approval gate the framework parks for you. |
| [`example-aisdk-agent`](example-aisdk-agent) | the [Vercel AI SDK](https://ai-sdk.dev) directly, no framework | you want to own the model loop and see every Plain call written out with nothing in between. |

`example-aisdk-agent` is Bun and uses the root install. `example-eve-agent` is npm and Node 24, for
the reasons below.

Setup is per package: each has its own `README.md` and its own `.env`, because what they need
differs. Start there, not here.

## The same agent, two architectures

Worth reading side by side, because the frameworks force genuinely different answers.

| | `example-eve-agent` | `example-aisdk-agent` |
| --- | --- | --- |
| Tools live in | one file each under `agent/tools/` | one closure in `src/agent.ts` |
| The gate is | `approval: always()` on the tool | `requestApproval` then poll |
| Waiting for a person | eve parks the turn durably | the turn is held open in memory |
| Plain writes come from | the channel's event handlers | the tool bodies |
| A tool learns the thread id from | the prompt, then checks it | the closure it was built with |

The last row is the sharpest difference. An eve tool gets no channel context, so the thread id
travels through the prompt and comes back as model output, which means the tools check it against
what a webhook actually delivered before reading a conversation or replying on it. The AI SDK
package builds its tools per turn, so the id is never in the model's hands at all.

## Repo layout

```
package.json                        Bun workspace root
example-eve-agent/                  eve runs the agent (npm + Node 24, see below)
example-aisdk-agent/                the AI SDK directly, no framework
```

`bun install` at the root covers `example-aisdk-agent`, and root `bun run test` and
`bun run typecheck` run it.

**`example-eve-agent` is deliberately outside the Bun workspace**, because eve requires npm and
Node 24: its CLI refuses to run under Bun, it pins TypeScript 7 against the other package's 5, and
it ships an npm lockfile. So the root `workspaces` list names the package explicitly rather than
globbing, since Bun ignores a negated pattern. Install and run that one from its own directory with
`npm ... --no-workspaces`; its README explains why the flag is needed.

## The approval gate

`reply_to_customer` is gated in both packages, and there is no environment variable to switch it
off. That is the point of the examples rather than a default worth tuning: everything else the
agent does is a read, and this is the only call a customer ever sees.

Reads are deliberately not gated. A card per search would turn the gate into noise people click
through, which is worse than no gate at all.

**Only a person can resolve a card.** `resolveDiscussionApproval` refuses a machine user with
"Machine user not allowed to perform this operation", even for the agent's own request. While a card
is open Plain also refuses any agent status change, so both packages skip that write rather than
attempt it.

## Answers come from the help center

Both packages call `searchKnowledgeSources`, so Plain does the retrieval and neither ships a vector
store or an embedding step. The search is scoped to help center articles with
`options: { types: ["HELP_CENTER_ARTICLE"] }`.

That scope matters more than it looks. A workspace with its own product docs indexed as documents
will see those outrank the help center on any query that shares a word with them, and the agent
then answers confidently about the wrong product. Drop the option to widen the search once you know
what is indexed.

An agent with nothing indexed searches successfully and finds nothing, which reads as a broken
agent rather than an empty help center. `bun run check` in the AI SDK package reports how many
results a sample query gets, so you find that out before the first turn rather than during it.
