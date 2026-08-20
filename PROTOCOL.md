# Building your own custom agent

What Plain sends you and what you send back, so you can implement this in any language. This repo is
one implementation; the calls below are the whole protocol.

Every request here was run against the live API. The mutations are shown with a placeholder
discussion id, so they answer `not_found` rather than succeeding, which is how you can tell a wrong
request shape from a wrong id.

## What you need in Plain

A machine user with an API key, the Custom agent toggle on, and a webhook target. See the
[README](README.md) for the click path. Minimum permissions:

- `threadDiscussionMessage:create` to post the answer
- `threadDiscussion:read` and `threadDiscussion:edit` to report status

## 1. The webhook you receive

Plain POSTs `discussion.message_created` to your URL every time a message lands in a discussion,
including the ones your own agent writes. These are the fields that matter:

```json
{
  "id": "ev_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  "type": "discussion.message_created",
  "timestamp": "2026-08-20T12:00:00Z",
  "workspaceId": "w_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  "webhookMetadata": { "webhookTargetVersion": "2026-08-19" },
  "payload": {
    "eventType": "discussion.message_created",
    "discussion": {
      "id": "thd_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      "type": "AGENT_SESSION",
      "status": "OPEN",
      "threadId": "th_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      "agent": { "id": "mu_01ARZ3NDEKTSV4RRFFQ69G5FAV" }
    },
    "message": {
      "id": "thdm_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      "type": "OUTBOUND",
      "markdown": "why did this customer's invoice fail?",
      "createdBy": { "actorType": "user", "userId": "u_01ARZ3NDEKTSV4RRFFQ69G5FAV" },
      "createdAt": "2026-08-20T12:00:00Z"
    }
  }
}
```

`discussion.agent.id` is the machine user the discussion was opened against, and
`message.markdown` is what the person typed. That is your prompt.

## 2. Verify the signature

Plain signs the body with your workspace secret ([Settings → Request
Signing](https://app.plain.com/~/settings/request-signing/)) and puts a hex SHA-256 HMAC in the
`Plain-Request-Signature` header.

```bash
printf '%s' "$RAW_BODY" | openssl dgst -sha256 -hmac "$PLAIN_WEBHOOK_SECRET" -hex
```

Run it over the **raw bytes** you received. Parsing the JSON and re-encoding it changes the
whitespace and the signature will never match. Compare in constant time.

## 3. Decide whether to answer

Answer only when all of these hold, or you will either loop forever or step on another agent:

| Condition | Why |
| --- | --- |
| `payload.discussion.type == "AGENT_SESSION"` | Other discussion types are not agent conversations |
| `payload.discussion.agent.id == your machine user id` | Otherwise it belongs to Sidekick or to somebody else's agent |
| `payload.message.type == "OUTBOUND"` | **On an agent session, a person's turn is OUTBOUND and your own replies come back as INBOUND.** Get this backwards and the agent answers itself forever |
| `payload.discussion.status != "RESOLVED"` | The conversation is over |

Your own replies arrive back as webhooks, so this filter is not optional.

## 4. Post your answer

```bash
curl -sX POST https://core-api.uk.plain.com/graphql/v1 \
  -H "Authorization: Bearer $PLAIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "mutation ($input: SendDiscussionMessageInput!) { sendDiscussionMessage(input: $input) { discussionMessage { id } error { message type code } } }",
    "variables": { "input": {
      "discussionId": "thd_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      "markdownContent": "The invoice failed because the card was declined."
    } }
  }'
```

```json
{"data":{"sendDiscussionMessage":{"discussionMessage":null,"error":{"message":"There was a validation error.","type":"VALIDATION","code":"not_found"}}}}
```

Errors come back inside `data`, with HTTP 200. Check `error` on every mutation rather than the
status code.

## 5. Report status

Plain runs no session for a custom agent, so nothing reports progress unless you do. Without these
calls the discussion looks permanently idle.

```bash
curl -sX POST https://core-api.uk.plain.com/graphql/v1 \
  -H "Authorization: Bearer $PLAIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "mutation ($input: UpdateDiscussionAgentStatusInput!) { updateDiscussionAgentStatus(input: $input) { discussion { id agentStatus } error { message type code } } }",
    "variables": { "input": {
      "discussionId": "thd_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      "agentStatus": "IN_PROGRESS"
    } }
  }'
```

The sequence per turn is `IN_PROGRESS` → post the answer → `IDLE`, and `NEEDS_INPUT` when you give
up. Settle on `IDLE` last: that is what marks the discussion unread, so the answer surfaces.

## 6. Two calls worth having

Identify which machine user your key is, so you can compare it against `discussion.agent.id`:

```bash
curl -sX POST https://core-api.uk.plain.com/graphql/v1 \
  -H "Authorization: Bearer $PLAIN_API_KEY" -H "Content-Type: application/json" \
  -d '{"query":"query { myMachineUser { id fullName isCustomAgent } }"}'
```

```json
{"data":{"myMachineUser":{"id":"mu_01ARZ3NDEKTSV4RRFFQ69G5FAV","fullName":"your agent","isCustomAgent":true}}}
```

`isCustomAgent: false` means it will never appear in the Ask Sidekick picker, whatever else you get
right.

Read the thread the discussion hangs off, for context on the first turn:

```bash
curl -sX POST https://core-api.uk.plain.com/graphql/v1 \
  -H "Authorization: Bearer $PLAIN_API_KEY" -H "Content-Type: application/json" \
  -d '{
    "query": "query ($discussionId: ID!) { discussion(discussionId: $discussionId) { id thread { title customer { fullName } } } }",
    "variables": { "discussionId": "thd_01ARZ3NDEKTSV4RRFFQ69G5FAV" }
  }'
```

## Gotchas

**Pin the webhook target to `2026-08-19` or later.** `discussion.message_created` was added in that
version. A target on an older one is silently never sent the event, and nothing anywhere reports an
error.

**Return 200 immediately, then work.** Plain retries anything that is not a 2xx, and a real answer
takes far longer than the delivery timeout. Answer the HTTP request first, do the work after.

**Deduplicate on `message.id`.** A retried delivery must not produce a second answer.

**Keep one model session per discussion, not per message.** Store the discussion id against whatever
session handle your model gives you and resume it on the next turn, or every message starts from
nothing and the conversation has no memory.
