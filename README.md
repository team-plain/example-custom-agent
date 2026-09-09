# Plain custom agent

This repository contains a working implementation for building [custom internal agents](https://www.plain.com/docs/agents/internal-agent) in Plain.

If you're looking to build a support agent that answers customers, see [this instead](https://www.plain.com/docs/agents/support-agent).

## Example agents
There are two example agent implementations you can find.

| Package | Agent built with | Reach for it when |
| --- | --- | --- |
| [`example-eve-agent`](example-eve-agent) | [Vercel eve](https://github.com/vercel/eve) | you want durable sessions and a working harness. |
| [`example-aisdk-agent`](example-aisdk-agent) | [Vercel AI SDK](https://ai-sdk.dev) | you want to own the model loop and build your own harness. |

## What the agent does

A teammate opens Ask Sidekick and asks the agent to handle a customer. From there:

```
list_thread_queue       what is waiting            \
search_threads          find the one they mean     /  only needed when the
read_customer_thread    what did the customer ask     discussion has no thread
search_knowledge        the help center, as many searches as it takes
reply_to_customer       a person approves, then it reaches the customer
```

Every call lands on the discussion timeline as it happens, so the team watches the work instead of
a spinner. Thread results carry a real `app.plain.com` link, so the agent hands people something
clickable rather than an id. The answer is grounded in the help center rather than in the model's memory, and the one
call a customer ever sees is the one call a person decides.

**A Sidekick session opened on nothing still works.** Plain does not always attach a thread, so the
agent can search the queue and find the one it needs rather than giving up.

**Both agents remember the conversation.** Plain is the store: the AI SDK package reads the
discussion's messages and sends them as a `messages` array, and eve resumes its own durable session
per discussion. Without that a turn starts from nothing, and a request like "the thread you just
replied to" has no referent, so the model guesses instead of asking.

## The packages

| Package | Agent built with | Reach for it when |
| --- | --- | --- |
| [`example-eve-agent`](example-eve-agent) | [Vercel eve](https://github.com/vercel/eve), a filesystem-first agent framework | you want durable sessions, one tool per file, and an approval gate the framework parks for you. |
| [`example-aisdk-agent`](example-aisdk-agent) | the [Vercel AI SDK](https://ai-sdk.dev) directly, no framework | you want to own the model loop and see every Plain call written out with nothing in between. |

## How the agents work
Both agents are built with several tools on top of Plain's API:
 - Listing and reading thread details
 - Searching through your knowledge sources in Plain
 - Reply to customer threads (gated behind human approval)
