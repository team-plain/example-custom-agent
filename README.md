# Plain custom agent examples

Reference implementations of one protocol: **Plain sends a webhook, your agent takes a turn, your
agent writes back.** Plain runs the infrastructure around the agent. The AI part, the model, the
prompt and the tools, is yours.

Each package below builds that agent side a different way. They are examples to read and take
from, not a framework to depend on.

The protocol itself lives in Plain's docs rather than in this repo.
[Build a support agent](https://www.plain.com/docs/agents/support-agent) and
[Build an internal agent](https://www.plain.com/docs/agents/internal-agent) give every event and every API
call, so you can build this in a language none of these packages use.

## The packages

| Package | Agent built with | Reach for it when |
| --- | --- | --- |
| [`example-coding-agent`](example-coding-agent) | an agent CLI you already run (`claude`, `codex`, `pi`, `opencode`) | you want the shortest path to a working agent, and the reasoning already happens in a CLI you trust. No model API key of its own. |
| `example-eve-agent` | [Vercel eve](https://github.com/vercel/eve), a filesystem-first agent framework | you want durable sessions, one tool per file, and sandboxed compute handed to you rather than hand-rolled. |
| `example-aisdk-agent` | the [Vercel AI SDK](https://ai-sdk.dev) directly, no framework | you want to own the model loop, and to see both of Plain's agent surfaces side by side on the raw API. |

All three are in the repo. `example-coding-agent` and `example-aisdk-agent` are Bun and share the
root install; `example-eve-agent` is npm and Node 24, for the reasons below.

Setup is per package: each one has its own `README.md` and its own `.env`, because what they need
differs. Start there, not here.

## The two surfaces

Plain has two places a custom agent can run, and they use different events and different mutations:

- A **support agent** works customer threads. It answers `thread.*` webhooks, reads the
  conversation, and replies, labels, notes, or hands off to a person. What it sends reaches the
  customer. See [Build a support agent](https://www.plain.com/docs/agents/support-agent).
- An **internal agent** answers your own team inside a Sidekick conversation. It answers
  `discussion.message_created`, reports its status, reports its tool calls, and can gate an action
  on someone's approval. Nothing it writes reaches the customer. See
  [Build an internal agent](https://www.plain.com/docs/agents/internal-agent).

`example-coding-agent` and `example-eve-agent` are internal agents. `example-aisdk-agent` does
both, from one shared core, which makes it the one place to compare them.

## Repo layout

```
package.json                        Bun workspace root
example-coding-agent/               an agent CLI does the thinking
example-eve-agent/                  eve runs the agent (npm + Node 24, see below)
example-aisdk-agent/                the AI SDK directly, and both surfaces
```

`bun install` at the root covers the Bun packages, and root `bun run test` and `bun run typecheck`
fan out across them.

**`example-eve-agent` is deliberately outside the Bun workspace**, because eve requires npm and
Node 24: its CLI refuses to run under Bun, it pins TypeScript 7 against the other package's 5, and
it ships an npm lockfile. So the root `workspaces` list names packages explicitly rather than
globbing, since Bun ignores a negated pattern. Install and run that one from its own directory with
`npm ... --no-workspaces`; its README explains why the flag is needed.

## The approval gate

Every package ships with the approval gate **on**. Before the agent's answer reaches anyone, a
person sees a card with Approve and Deny.

That is deliberate and it is not a default worth changing lightly: an example that shipped the gate
switched off would teach you nothing about the part of building an agent that is actually hard. Each
package documents its own switch for turning it off while you are experimenting.
