# Example custom agent

In Plain, Ask Sidekick lets a teammate pick which agent answers a thread. 

Pick a custom agent and power the Ask Sidekick surface with your own agent.

## How it works
Plain fires a webhook at your server and waits for you to write the reply
back. It answers by running the `claude` CLI on whatever machine it is running
on, then posts the answer into the discussion.
```
┌─────────────────────┐                              ┌─────────────────────┐
│        Plain        │  discussion.message_created  │     this process    │
│     Ask Sidekick    │ ───────────────────────────> │    bun run serve    │
│                     │                              │                     │
│                     │ <─────────────────────────── │                     │
└─────────────────────┘    sendDiscussionMessage     └──────────┬──────────┘
                                                                │
                                                                v
                                                     ┌─────────────────────┐
                                                     │     Claude Code     │
                                                     │      claude -p      │
                                                     └─────────────────────┘
```

Claude runs with `--permission-mode auto` and no sandbox. The prompt is whatever someone typed into
a discussion, which means anyone in your workspace effectively has a shell on this machine. 

It's recommended to run this in a sandbox when deployed in a production environment.

Written in TypeScript, run with [Bun](https://bun.sh).

## Setting it up

1. Create a machine user under [Settings → Machine users](https://app.plain.com/~/settings/machine-users/)
   and give it an API key.

   Make sure you also toggle the "Custom agent" toggle on the machine user so it's available as a
   target when running a Sidekick conversation.

   Minimum permissions required:

   - `threadDiscussionMessage:create`
   - `threadDiscussion:read`

2. Copy `.env.example` to `.env`.

   Fill in `PLAIN_API_KEY`, and `PLAIN_WEBHOOK_SECRET` from
   [Settings → Request Signing](https://app.plain.com/~/settings/request-signing/).

3. Get a public https URL that reaches this process. To run locally, use `ngrok http 8081`.

   Otherwise it's wherever you deploy it, which has to be somewhere that holds a long-running
   process and has the `claude` CLI installed.

   Put the URL in `.env` as `PUBLIC_URL`.

4. Create the webhook under
   [Settings → Webhooks → Add webhook target](https://app.plain.com/~/settings/webhooks/add/).

   Pointed at `$PUBLIC_URL/plain/webhook`, subscribed to `discussion.message_created`, on version
   `2026-08-19` or later.

## Running it

```
bun install
bun run help      # the commands, which provider CLIs are installed, what .env is missing
bun run check     # who the key is, what it can do, where the webhooks point
bun run serve
```

Then open a thread in Plain, click Ask Sidekick, pick your agent and ask it something.

The system prompt is `prompt.md`, prepended to the first message of each discussion. Edit it to
change what the agent is and what it will do.

Each turn runs `IN_PROGRESS` → post the answer → `IDLE`, and a failed turn posts the error and still
settles on `IDLE`. Settling last is what marks the discussion unread, so the answer surfaces.

Set `PLAIN_RESOLVE_WHEN_DONE=1` to also resolve the discussion once the agent has answered, via
`changeThreadDiscussionStatus`. It is off by default, because this example cannot tell a finished
conversation from a pause and a resolved discussion drops out of the customer's view. See
[PROTOCOL.md](PROTOCOL.md) for when to reach for it.

## Approving what the agent does

**Before the agent posts its answer, it asks a human.** The draft appears in the app as a card with
Approve and Deny, and the agent waits. Deny with a note and it redrafts once, then asks again.

`PLAIN_GATE_REPLY=0` turns that off. `PLAIN_GATE_RESOLVE=0` turns off the same gate on resolving, which
only applies when `PLAIN_RESOLVE_WHEN_DONE=1`. **Both are on by default**: an example that ships the gate
switched off teaches nothing. The failure report the agent posts when its runner dies is never gated,
because a gated failure notice can leave a broken discussion silent.

The agent gates its own writes rather than tool calls, because it delegates thinking to a CLI and never
sees a tool call. A real agent gates tool calls the same way. [PROTOCOL.md](PROTOCOL.md) has the flow.

`PLAIN_API_URL` overrides the API endpoint, which defaults to production. Set it to run this against
another stage.

## Using a different agent CLI

Claude Code is the default. `--provider` swaps it for another CLI you have installed and logged in
already, since this project holds no model API key of its own.

```
bun run serve --provider codex     # claude (default), codex, pi, opencode
```

Sessions are stored per provider, one file per discussion, in `sessions/<provider>/`.

## Building your own

[PROTOCOL.md](PROTOCOL.md) has the webhook payload, every API call with a working curl, and the
gotchas, so you can implement this in any language.
