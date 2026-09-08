# example-eve-agent

An internal Plain agent built on [eve](https://eve.dev/docs), Vercel's filesystem-first agent
framework. Reach for this one when you want durable sessions, one tool per file and a model loop you
do not have to write.

For the other shapes see the [repo README](../../README.md). For the protocol this implements, every
event and every API call, see
[Build an internal agent](https://www.plain.com/docs/agents/internal-agent).

## This package is not part of the Bun workspace

Every other package here is Bun. **This one is npm and Node 24**, because eve requires it:

- The eve CLI refuses to run under Bun. `bun x eve --version` answers
  `eve requires Node.js >=24. You are running v22.22.3`.
- eve pins TypeScript 7, where the Bun package uses 5. One `node_modules` cannot hoist both.
- eve ships `package-lock.json`, and a Bun workspace has a single root `bun.lock`.

So `bun install` at the repo root does **not** cover this directory, and the root `workspaces` list
names packages explicitly rather than globbing, because Bun ignores a negated pattern.

**Every npm command here needs `--no-workspaces`.** Without it npm walks up, finds the repo root's
`package.json`, and installs against that instead:

```bash
cd packages/example-eve-agent
npm install --no-workspaces
npm run typecheck --no-workspaces
```

**`eve` is pinned to an exact version, not a caret.** It is 0.x and in public beta, and its own
terms say the APIs may change before general availability. Bump it deliberately and re-read
`node_modules/eve/docs`, which is where its real documentation lives.

## How a turn works

```
┌─────────────────┐  discussion.message_created   ┌──────────────────────────────┐
│      Plain      │ ────────────────────────────> │  agent/channels/plain.ts     │
│   Ask Sidekick  │                               │  POST /plain/webhook         │
│                 │ <──────────────────────────── │  from(discussion.id).send()  │
└─────────────────┘   the event handlers write     └──────────────┬───────────────┘
                                                                  │
                                                        one eve session
                                                        per discussion
```

`from(discussion.id).send()` is the whole discussion-to-session mapping. eve creates the session on
the first message and resumes it on every later one, so there is no session store here and no
resume id to keep. That is the main reason this package is shorter than `example-coding-agent`.

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

## The approval gate

`agent/tools/page_oncall.ts` is gated with `always()` from `eve/tools/approval`, so the model cannot
run it without a person agreeing first. The paging is mocked; the gate is not, and the gate is the
part worth copying.

The two protocols line up almost exactly, which is why this package is a good place to see it:

1. The model calls the tool. eve parks the turn durably and emits `input.requested`.
2. The channel reports the call to Plain and asks for approval. Plain shows a card and moves the
   discussion to `TOOL_CALL_APPROVAL_PENDING`.
3. A person approves or denies. Plain sends `discussion.tool_call_approval_resolved`.
4. The channel answers the parked request with `respond()`, and eve picks the turn back up exactly
   where it left off.

`requestId` is the only thing joining the two, which is why the channel records the Plain
`toolCallId` against it when the request arrives.

**On a denial the channel writes nothing further.** Plain has already failed that call with the
reviewer's note as its error, and eve reports the result as `rejected`, so a second write would be a
worse explanation of something already explained.

## Running it

```bash
cd packages/example-eve-agent
npm install --no-workspaces
cp .env.example .env
```

Fill in `PLAIN_API_KEY` and `PLAIN_WEBHOOK_SECRET`, then get a public URL and point a webhook at it:

- URL: `<your public URL>/plain/webhook`
- Events: `discussion.message_created` and `discussion.tool_call_approval_resolved`
- Version: `2026-09-06`

That version is not cosmetic. `@team-plain/webhooks` understands exactly one webhook version, and a
target set newer fails as hard as one set older: Plain delivers, the server answers 401, and the
discussion sits on "thinking" with only your own log to say why.

```bash
npm run dev --no-workspaces     # eve's dev server and REPL
```

## The model credential

eve's default model is a string id routed through the Vercel AI Gateway, which needs
`AI_GATEWAY_API_KEY`, or a `VERCEL_OIDC_TOKEN` that `eve link` pulls from a Vercel project.

To skip the gateway, use a provider model directly: install `@ai-sdk/anthropic`, set
`ANTHROPIC_API_KEY`, and pass the model object in `agent/agent.ts`.

## What has not been verified

**No live turn has run through this package.** The channel, the tool and the client typecheck
against eve's real types, and the event names and payloads were read from
`node_modules/eve/dist`, not guessed. But no real webhook, Ask Sidekick conversation, reply or
approval card has been exercised end to end, because that needs a machine user with the Custom
agent toggle on and a model credential. Treat the wiring as reviewed, not as proven.
