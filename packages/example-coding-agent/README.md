# example-coding-agent

An internal Plain agent whose thinking is done by an agent CLI you already have installed and
logged in: `claude` by default, or `codex`, `pi`, `opencode`. This package holds no model API key of
its own.

Reach for this one when you want the shortest path from a webhook to a working agent, and you
already trust a CLI to do the reasoning. For the other two shapes see the
[repo README](../../README.md); for the protocol this implements, every event and every API call,
see [Build an internal agent](https://www.plain.com/docs/agents/internal-agent).

## How it works

Plain fires a webhook at your server and waits for you to write the reply back. This package answers
by running the `claude` CLI, then posts the answer into the discussion.

```
┌─────────────────────┐                              ┌─────────────────────┐
│        Plain        │  discussion.message_created  │     this process    │
│     Ask Sidekick    │ ───────────────────────────> │    bun run serve    │
│                     │                              │                     │
│                     │ <─────────────────────────── │                     │
└─────────────────────┘    sendDiscussionMessage     └──────────┬──────────┘
                                                                │
                                          AGENT_RUNTIME decides where
                                                                │
                                         ┌──────────────────────┴───────────┐
                                         v                                  v
                              ┌─────────────────────┐          ┌─────────────────────┐
                              │  local (default)    │          │   vercel-sandbox    │
                              │     claude -p       │          │  claude -p, in a VM │
                              │   on this machine   │          │  one per discussion │
                              └─────────────────────┘          └─────────────────────┘
```

Claude runs with `--permission-mode auto`, and the prompt is whatever someone typed into a
discussion. **On the default `local` runtime that means anyone in your workspace effectively has a
shell on this machine.** Set `AGENT_RUNTIME=vercel-sandbox` in production, which is the same command
in a throwaway VM instead. See [Where the CLI runs](#where-the-cli-runs).

Written in TypeScript, run with [Bun](https://bun.sh).

## Setting it up

1. Create a machine user under [Settings → Machine users](https://app.plain.com/~/settings/machine-users/)
   and give it an API key.

   Make sure you also toggle the "Custom agent" toggle on the machine user so it's available as a
   target when running a Sidekick conversation.

   Minimum permissions required:

   - `threadDiscussionMessage:create`
   - `threadDiscussion:read`

2. Copy `.env.example` to `.env`, in this directory.

   ```
   cd packages/example-coding-agent
   cp .env.example .env
   ```

   Fill in `PLAIN_API_KEY`, and `PLAIN_WEBHOOK_SECRET` from
   [Settings → Request Signing](https://app.plain.com/~/settings/request-signing/).

   The `.env` is read from this directory whatever directory you start the process in, so pointing
   the agent at a codebase does not cost you your configuration.

3. Get a public https URL that reaches this process. To run locally, use `ngrok http 8081`.

   Otherwise it's wherever you deploy it, which has to be somewhere that holds a long-running
   process. It also needs the `claude` CLI installed, unless you set `AGENT_RUNTIME=vercel-sandbox`
   and let the sandbox carry it.

   Put the URL in `.env` as `PUBLIC_URL`.

4. Create the webhook under
   [Settings → Webhooks → Add webhook target](https://app.plain.com/~/settings/webhooks/add/).

   Pointed at `$PUBLIC_URL/plain/webhook`, subscribed to `discussion.message_created`, on version
   `2026-09-06`. The version has to match `@team-plain/webhooks` exactly, see below.

## Running it

```
bun install       # from here or the repo root, either resolves the whole workspace
bun run help      # the commands, which provider CLIs are installed, what .env is missing
bun run check     # who the key is, what it can do, where the webhooks point
bun run serve
```

Then open a thread in Plain, click Ask Sidekick, pick your agent and ask it something.

The system prompt is `prompt.md` in this directory, prepended to the first message of each
discussion. Edit it to change what the agent is and what it will do.

Each turn runs `IN_PROGRESS` → post the answer → `IDLE`, and a failed turn posts the error and still
settles on `IDLE`. Posting the answer is what marks the discussion unread, not the status change, so
settle last only to stop the status claiming the agent is still working.

Set `PLAIN_RESOLVE_WHEN_DONE=1` to also resolve the discussion once the agent has answered, via
`changeThreadDiscussionStatus`. It is off by default, because this example cannot tell a finished
conversation from a pause and a resolved discussion drops out of the customer's view. See
[Resolve the conversation](https://www.plain.com/docs/agents/internal-agent#resolve-the-conversation)
for when to reach for it.

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

**Before the agent posts its answer, it asks a human.** The draft appears in the app as a card with
Approve and Deny, and the agent waits. Deny with a note and it redrafts once, then asks again.

`PLAIN_GATE_REPLY=0` turns that off. `PLAIN_GATE_RESOLVE=0` turns off the same gate on resolving, which
only applies when `PLAIN_RESOLVE_WHEN_DONE=1`. **Both are on by default**: an example that ships the gate
switched off teaches nothing. The failure report the agent posts when its runner dies is never gated,
because a gated failure notice can leave a broken discussion silent.

The agent gates its own writes rather than tool calls, because it delegates thinking to a CLI and never
sees a tool call. A real agent gates tool calls the same way.
[Gate an action on a user](https://www.plain.com/docs/agents/internal-agent#gate-an-action-on-a-user)
has that flow.

It learns the decision by polling, which keeps the flow readable in one function. There are webhooks
for it, `discussion.tool_call_approval_requested` and `discussion.tool_call_approval_resolved`, and
they are the better choice once a turn can outlive the process. The docs have both payloads.

`PLAIN_API_URL` overrides the API endpoint, which defaults to production. Set it to run this against
another stage.

## Using a different agent CLI

Claude Code is the default. `--provider` swaps it for another CLI you have installed and logged in
already, since this project holds no model API key of its own.

```
bun run serve --provider codex     # claude (default), codex, pi, opencode
```

Sessions are stored per provider, one file per discussion, in `sessions/<provider>/`.

## Where the CLI runs

`AGENT_RUNTIME` picks the runtime. It defaults to `local`, so nothing changes until you set it.

| | `local` (default) | `vercel-sandbox` |
| --- | --- | --- |
| Where the CLI runs | this machine | a Vercel Sandbox, one per discussion |
| Needs the CLI installed here | yes | no |
| Sees the directory you started in | yes | no, the sandbox starts empty |
| Authenticates as | your own CLI login | `ANTHROPIC_API_KEY` from `.env` |
| Providers | all four | `claude` only |

The command is identical in both. Only the machine it runs on differs, so the prompt, the system
prompt and `--resume` behave the same either way.

```
AGENT_RUNTIME=vercel-sandbox
VERCEL_BEARER_TOKEN=...
VERCEL_SANDBOX_TEAM_ID=...
VERCEL_SANDBOX_PROJECT_ID=...
ANTHROPIC_API_KEY=...
```

**One sandbox per discussion, and it is persistent.** The CLI's own session files live inside it, so
`--resume` on the second turn finds the first. Its session lasts ten minutes, which is a lifetime and
not an idle timer, and each turn asks to extend it. When it does stop, Vercel resumes it with its
files on the next turn: stopping is not deleting.

**After a week the sandbox is collected, and the discussion starts a new session rather than
breaking.** A replaced sandbox holds none of the CLI's files, so the agent notices and opens a fresh
session instead of resuming an id that points at nothing. The discussion keeps working, without the
earlier context.

**A sandbox holds none of your logins**, which is why `ANTHROPIC_API_KEY` is required here and not
locally. It is passed into the sandbox per command and never printed. `ANTHROPIC_AUTH_TOKEN` and
`ANTHROPIC_BASE_URL` are forwarded the same way, if you go through a gateway.

**Set `VERCEL_SANDBOX_SNAPSHOT_ID` if you have a snapshot with the CLI in it.** Without one, each new
sandbox runs `npm install -g @anthropic-ai/claude-code` at first start, and the discussion's first
turn waits for it. Either way the sandbox is checked for `claude` on PATH before any turn runs, so a
snapshot built without it fails loudly rather than one turn at a time.

**The sandbox isolates the machine, not the network.** It gets Vercel's default full internet
access, which is what lets it install the CLI and reach the model. If the prompt should not be able
to reach your internal services, give the sandbox a network policy: `@vercel/sandbox` takes one at
creation, in `src/sandbox.ts`.

`bun run check` prints which runtime is active and what it is missing.

## Building your own

[Build an internal agent](https://www.plain.com/docs/agents/internal-agent) has the webhook payloads, every
API call and the gotchas, so you can implement this in any language.
[Build a support agent](https://www.plain.com/docs/agents/support-agent) is the other surface: an agent on
customer threads rather than on an internal Sidekick conversation.
