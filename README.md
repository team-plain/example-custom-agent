# Plain example custom agent

A **custom agent for Plain**, written in TypeScript and run with [Bun](https://bun.sh).

In Plain, a support teammate opens **Ask Sidekick** on a thread and picks an agent from the picker.
Picking Plain's own Sidekick runs Plain's agent. Picking a *custom* agent means Plain runs nothing:
it just fires a webhook at **your** server and waits for you to write the answer back. This project
is that server. It answers by running the `claude` CLI on the machine it is running on and posting
the reply into the discussion.

```
Plain  --discussion.message_created webhook-->  this process  --claude -p-->  Claude Code
                                                     |
                                                     +--sendDiscussionMessage--> Plain
```

There is no SDK here, just `fetch` against Plain's GraphQL API. The TypeScript SDK bundles a webhook
schema frozen at `2026-02-27` that does not know `discussion.message_created` and rejects the event.

> **This gives a Plain discussion shell access to this machine.** Claude runs with
> `--permission-mode auto` and no sandbox, so it approves its own tool calls and can read and change
> anything the user running this process can. Whatever a teammate types in a discussion becomes the
> prompt. Run it on a machine you are willing to hand over, not on your laptop with production
> credentials sitting in it.

## What it does on each delivery

1. Verifies the `Plain-Request-Signature` HMAC over the raw request body.
2. Returns `200` immediately, then works in the background. Plain retries anything that is not a
   2xx, and a Claude turn takes far longer than the delivery timeout.
3. Answers only if the discussion is an `AGENT_SESSION` bound to **this** machine user and the
   message is a person's turn (`OUTBOUND`). On an agent session the agent's own output is `INBOUND`,
   so getting this backwards makes it answer itself forever.
4. Sets `agentStatus` to `IN_PROGRESS`, runs `claude -p`, posts the answer, then settles on `IDLE`.
   Plain runs no session for a custom agent, so without those calls the discussion looks permanently
   idle. Settling on `IDLE` is also what marks it unread, so the answer surfaces.
5. Keeps one Claude session per discussion in `workdir/sessions.json`, so a discussion is one
   conversation rather than a series of unrelated questions.

## Set it up in Plain

### 1. Create a machine user and an API key

Plain dashboard -> **Settings -> Machine users -> New machine user**, then create an API key on it.

The key needs:

| Permission | Why |
| --- | --- |
| `threadDiscussionMessage:create` | **Required.** Post the answer. Nothing works without it. |
| `threadDiscussion:read` and `threadDiscussion:edit` | Recommended. Report `IN_PROGRESS` / `IDLE`, otherwise the discussion shows no agent status. `updateDiscussionAgentStatus` reads the discussion before editing it, so it needs both. |
| `thread:read` | Optional. Puts the thread title and customer in the first prompt. |
| `webhookTarget:read` / `:create` / `:edit` | Optional. Only so `bun run setup` can create and repoint the webhook target for you. |

Put the key in `.env` as `PLAIN_API_KEY`.

### 2. Mark the machine user as a custom agent

**Settings -> Machine users -> your machine user -> Custom agent.** Without this it never shows up
in the Ask Sidekick picker, and nothing else you do will make it appear.

### 3. Copy the webhook signing secret

**Settings -> Webhooks -> Signing secret**, into `.env` as `PLAIN_WEBHOOK_SECRET`. An API key cannot
read this itself (the query is human-user only), so it has to be pasted.

### 4. Point a webhook at this process

You need a public https URL that reaches it.

- **Locally:** `ngrok http 8081` and use the https URL it prints. It changes every restart, so
  expect to repoint the target.
- **Deployed:** the https URL of wherever you run this (Fly, Railway, a VM, anything that can hold a
  long-lived process and run the `claude` CLI). Serverless will not work: a turn outlives a
  function.

Put it in `.env` as `PUBLIC_URL`, then either create the target in the dashboard
(**Settings -> Webhooks -> New**):

- URL: `$PUBLIC_URL/plain/webhook`
- Event: `discussion.message_created`
- **Version: `2026-08-19` or later.** The event was added in that version, and a target pinned to an
  older one is silently never sent it.

Or, if the key holds the `webhookTarget:*` permissions, let the agent do it:

```
bun run setup
```

`setup` repoints the existing target pointing at `/plain/webhook` instead of adding a second one,
which is what you want each time ngrok hands you a new hostname.

## Run it

```
bun install
bun run check     # who the key is, what it can do, where its webhooks point
bun run serve     # start the agent
```

Then open a thread in Plain, click **Ask Sidekick**, pick your agent and ask it something.

## Commands

| Command | What it does |
| --- | --- |
| `bun run serve` | Runs the agent. This is the default. |
| `bun run check` | Prints the machine user, the custom-agent flag, the key's permissions and the workspace's webhook targets. |
| `bun run setup` | Creates or repoints the webhook target at `$PUBLIC_URL`. |
| `bun run simulate "question"` | Posts a synthetic, correctly signed delivery at a running `serve`. |

`simulate` needs nothing from Plain except the API key, so it separates a local bug from a webhook
that never arrived. The discussion id it uses is fake, so the answer fails to post with `not_found`:
that is expected, and everything before that point is real.

## Configuration

`.env` overrides the shell on purpose: a stale exported `PLAIN_API_KEY` silently runs the agent as a
different machine user, which is very hard to spot.

| Variable | Default | Notes |
| --- | --- | --- |
| `PLAIN_API_KEY` | — | Required. |
| `PLAIN_WEBHOOK_SECRET` | — | Required. Workspace signing secret. |
| `PUBLIC_URL` | — | The https URL that reaches this process. Only needed for `setup`. |
| `PORT` | `8081` | |
| `PLAIN_API_URL` | `https://core-api.uk.plain.com/graphql/v1` | |
| `CLAUDE_BIN` | `claude` | |
| `CLAUDE_CWD` | your home directory | Where Claude starts. It can reach the whole filesystem regardless. |
| `CLAUDE_PERMISSION_MODE` | `auto` | Set it to `plan` or `default` to make it far less capable and far safer. |
| `CLAUDE_TIMEOUT_SECONDS` | `180` | |
| `AGENT_WORKDIR` | `./workdir` | Where `sessions.json` lives. |

Claude Code uses its own logged-in session, so there is no Anthropic key anywhere in this project.

## Files

| File | Role |
| --- | --- |
| `src/index.ts` | Commands and the webhook-target setup |
| `src/config.ts` | `.env` loading and config |
| `src/plain.ts` | Plain GraphQL client |
| `src/webhook.ts` | Signature check, payload types, and which deliveries to answer |
| `src/claude.ts` | Runs `claude -p` and keeps one session per discussion |
| `src/serve.ts` | HTTP server and the respond loop |
| `src/check.ts` | Prints what the key can do |
| `src/simulate.ts` | Synthetic signed delivery for local testing |
