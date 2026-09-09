# Plain custom agent

This repository contains a working implementation for building [custom internal agents](https://www.plain.com/docs/agents/internal-agent) in Plain.

If you're looking to build a support agent that answers customers, see [this instead](https://www.plain.com/docs/agents/support-agent).

## Example agents
There are two example agent implementations you can find.

| Package | Agent built with | Reach for it when |
| --- | --- | --- |
| [`example-eve-agent`](example-eve-agent) | [Vercel eve](https://github.com/vercel/eve) | you want durable sessions and a working harness. |
| [`example-aisdk-agent`](example-aisdk-agent) | [Vercel AI SDK](https://ai-sdk.dev) | you want to own the model loop and build your own harness. |

## How the agents work
Both agents are built with several tools on top of Plain's API:
 - Listing and reading thread details
 - Searching through your knowledge sources in Plain
 - Reply to customer threads (gated behind human approval)
