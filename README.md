# Plain example custom agent

In Plain, Ask Sidekick lets a teammate pick which agent answers a thread. Pick a custom agent and
Plain runs nothing itself: it fires a webhook at your server and waits for you to write the reply
back. This is that server. It answers by running the `claude` CLI on whatever machine it is running
on, then posts the answer into the discussion.

```
Plain  --discussion.message_created webhook-->  this process  --claude -p-->  Claude Code
                                                     |
                                                     +--sendDiscussionMessage--> Plain
```

Claude runs with `--permission-mode auto` and no sandbox, so it approves its own tool calls and can
read or change anything the user running this process can. The prompt is whatever someone typed into
a discussion, which means anyone in your workspace effectively has a shell on this machine. Run it
somewhere you don't mind that.

Written in TypeScript, run with [Bun](https://bun.sh). No SDK: the TypeScript SDK pins a webhook
schema from `2026-02-27` that doesn't know `discussion.message_created` and rejects the event.

## Setting it up in Plain

1. Create a machine user under Settings -> Machine users and give it an API key. The key needs
   `threadDiscussionMessage:create`, which is how the answer gets posted. Add `threadDiscussion:read`
   and `threadDiscussion:edit` so the discussion shows an agent status while the agent works, and the
   `webhookTarget:*` permissions if you want `bun run setup` to manage the webhook for you.

2. Turn on Custom agent for that machine user. Until you do, it never appears in the Ask Sidekick
   picker and nothing else you set up will make it show.

3. Copy `.env.example` to `.env`. Fill in `PLAIN_API_KEY`, and `PLAIN_WEBHOOK_SECRET` from
   Settings -> Webhooks -> Signing secret. An API key can't read that secret, so it has to be pasted.

4. Get a public https URL that reaches this process. Locally that's `ngrok http 8081`. Otherwise it's
   wherever you deploy it, which has to be somewhere that holds a long-running process and has the
   `claude` CLI installed, so serverless won't work. Put the URL in `.env` as `PUBLIC_URL`.

5. Create the webhook under Settings -> Webhooks -> New, pointed at `$PUBLIC_URL/plain/webhook`,
   subscribed to `discussion.message_created`, on version `2026-08-19` or later. Earlier versions
   don't carry that event, and a target pinned to one is silently never sent it. If the key has the
   `webhookTarget:*` permissions, `bun run setup` does this instead, and repoints the existing target
   every time ngrok hands you a new hostname.

## Using it

```
bun install
bun run check     # who the key is, what it can do, where the webhooks point
bun run serve
```

Then open a thread in Plain, click Ask Sidekick, pick your agent and ask it something. Each
discussion keeps its own Claude session in `workdir/sessions.json`, so a discussion is one
conversation rather than a series of unrelated questions.

`bun run simulate "question"` posts a signed fake delivery at a running `serve`, which is the fastest
way to tell a local bug from a webhook that never arrived. The discussion id in it isn't real, so
posting the answer fails with `not_found`. Everything before that point is real.

Config lives in `.env`, documented in `.env.example`. `CLAUDE_PERMISSION_MODE` is the one worth
knowing about: set it to `plan` or `default` to make the agent much less capable and much safer.
`.env` overrides your shell on purpose, because a stale exported `PLAIN_API_KEY` quietly runs the
agent as a different machine user.
