import { describe, expect, test } from "bun:test";
import type { DiscussionPayload } from "./serve.ts";
import { shouldAnswerDiscussion, threadIDOf, whyNotAnswering } from "./serve.ts";
import { cardText, conversation, mayReplyTo, promptWithContext, threadIDsIn } from "./agent.ts";

const ME = "mu_agent";

// Values are `unknown` rather than the real field types, because a fixture only fills the fields
// the code under test reads. `agent` alone carries nine more required fields.
type DiscussionOverride = Partial<Record<keyof DiscussionPayload["discussion"], unknown>>;

function discussion(over: DiscussionOverride = {}) {
  return {
    id: "disc_1",
    type: "AGENT_SESSION",
    agent: { id: ME },
    status: "OPEN",
    threadId: "th_1",
    ...over,
  } as unknown as DiscussionPayload["discussion"];
}

function delivery(over: { discussion?: DiscussionOverride; messageType?: string } = {}): DiscussionPayload {
  return {
    eventType: "discussion.message_created",
    discussion: discussion(over.discussion),
    message: {
      id: "msg_1",
      type: over.messageType ?? "OUTBOUND",
      markdown: "answer this please",
    },
  } as unknown as DiscussionPayload;
}

describe("deciding whether to answer", () => {
  test("answers a teammate's message on its own session", () => {
    expect(shouldAnswerDiscussion(delivery(), ME)).toBe(true);
  });

  // The loop guard. Its own replies come back as INBOUND, so without this it answers itself.
  test("ignores its own reply coming back", () => {
    expect(shouldAnswerDiscussion(delivery({ messageType: "INBOUND" }), ME)).toBe(false);
  });

  test("ignores a discussion belonging to another agent", () => {
    expect(shouldAnswerDiscussion(delivery({ discussion: { agent: { id: "mu_other" } } }), ME)).toBe(
      false,
    );
  });

  test("ignores a discussion with no agent at all", () => {
    expect(shouldAnswerDiscussion(delivery({ discussion: { agent: null } }), ME)).toBe(false);
  });

  test("ignores a non-agent discussion type", () => {
    expect(shouldAnswerDiscussion(delivery({ discussion: { type: "SLACK" } }), ME)).toBe(false);
  });

  test("ignores a resolved discussion", () => {
    expect(shouldAnswerDiscussion(delivery({ discussion: { status: "RESOLVED" } }), ME)).toBe(false);
  });
});

describe("finding the customer thread", () => {
  test("reads it off the discussion", () => {
    expect(threadIDOf(delivery())).toBe("th_1");
  });

  // threadId is nullable on the payload, and a discussion opened on nothing has no customer to
  // read or reply to. Null rather than undefined so the tools can branch on it.
  test("is null when the discussion is not on a thread", () => {
    expect(threadIDOf(delivery({ discussion: { threadId: null } }))).toBeNull();
  });
});

describe("telling the model where it is", () => {
  test("names the thread when there is one", () => {
    const prompt = promptWithContext("answer this", { discussionID: "disc_1", threadID: "th_1" });
    expect(prompt).toContain("th_1");
    expect(prompt).toContain("answer this");
  });

  // A threadless session is not a dead one any more: it is pointed at the queue instead.
  test("points at the queue when there is not", () => {
    const prompt = promptWithContext("answer this", { discussionID: "disc_1", threadID: null });
    expect(prompt).toContain("not attached to a customer thread");
    expect(prompt).toContain("list_thread_queue");
  });
});

describe("the approval card", () => {
  const target = { id: "th_9", title: "Cannot log in", customerName: "Ada Byron" };

  // The agent can now reply to a thread it discovered, so approving a reply aimed at the wrong
  // customer is the mistake the card exists to catch. Name leads, then the thread, then the draft.
  test("leads with who receives the reply and on which thread", () => {
    const card = cardText(target, "Try resetting your password.");
    expect(card).toContain("Ada Byron");
    expect(card).toContain("Cannot log in");
    expect(card).toContain("th_9");
    expect(card.indexOf("Ada Byron")).toBeLessThan(card.indexOf("Try resetting"));
  });

  // A reviewer checking the thread should be one click away, not pasting an id into a search box.
  test("prefers the clickable link over the raw id", () => {
    const card = cardText({ ...target, url: "https://app.plain.com/workspace/w_1/thread/th_9/" }, "hi");
    expect(card).toContain("https://app.plain.com/workspace/w_1/thread/th_9/");
  });

  // The workspace id needs a scope some machine users lack, so the link can legitimately be null.
  test("falls back to the id when there is no link", () => {
    expect(cardText({ ...target, url: null }, "hi")).toContain("th_9");
  });

  test("carries the whole draft, not a summary", () => {
    const draft = "Here is a very specific answer with steps.";
    expect(cardText(target, draft)).toContain(draft);
  });
});

describe("building the conversation", () => {
  const ctx = { discussionID: "disc_1", threadID: "th_1" };

  // The bug this fixes: with a single prompt string the model started every turn from nothing, so
  // "the thread you just replied to" had no referent and it picked one at random.
  test("earlier turns come through, oldest first", () => {
    const history = [
      { role: "user" as const, content: "whats up with my queue" },
      { role: "assistant" as const, content: "I answered the CC vs BCC thread." },
      { role: "user" as const, content: "give me a link" },
    ];
    const messages = conversation(history, "give me a link", ctx);
    expect(messages).toHaveLength(3);
    expect(messages[0]?.content).toBe("whats up with my queue");
    expect(messages[1]?.role).toBe("assistant");
  });

  // Plain stores the message before the webhook fires, so it is already in the history. Sending it
  // twice would show the model the same question as two separate turns.
  test("the message being answered is not duplicated", () => {
    const history = [
      { role: "user" as const, content: "first" },
      { role: "user" as const, content: "second" },
    ];
    const messages = conversation(history, "second", ctx);
    expect(messages).toHaveLength(2);
    expect(messages.filter((m) => m.content.includes("second"))).toHaveLength(1);
  });

  test("the where-am-I preamble rides on the newest message only", () => {
    const messages = conversation([{ role: "user", content: "old" }], "new", ctx);
    expect(messages[0]?.content).toBe("old");
    expect(messages[1]?.content).toContain("th_1");
    expect(messages[1]?.content).toContain("new");
  });

  test("an empty history is just the one message", () => {
    expect(conversation([], "hello", ctx)).toHaveLength(1);
  });

  // A person can ask the same thing twice. Filtering by content would delete the earlier one too
  // and quietly shorten the history.
  test("an identical earlier question survives", () => {
    const history = [
      { role: "user" as const, content: "any update" },
      { role: "assistant" as const, content: "not yet" },
      { role: "user" as const, content: "any update" },
    ];
    const messages = conversation(history, "any update", ctx);
    expect(messages).toHaveLength(3);
    expect(messages[0]?.content).toBe("any update");
    expect(messages[1]?.content).toBe("not yet");
  });
});

describe("saying why a delivery was dropped", () => {
  // "not this agent's turn" sent people hunting for a broken agent. Each refusal now names itself.
  test("a resolved discussion says to start a new session", () => {
    const why = whyNotAnswering(delivery({ discussion: { status: "RESOLVED" } }), ME);
    expect(why).toContain("RESOLVED");
    expect(why).toContain("new Ask Sidekick session");
  });

  test("its own reply says the message is not a person's turn", () => {
    expect(whyNotAnswering(delivery({ messageType: "INBOUND" }), ME)).toContain("INBOUND");
  });

  test("another agent's discussion names the other agent", () => {
    const why = whyNotAnswering(delivery({ discussion: { agent: { id: "mu_other" } } }), ME);
    expect(why).toContain("mu_other");
  });

  test("null when there is nothing wrong", () => {
    expect(whyNotAnswering(delivery(), ME)).toBeNull();
  });
});

describe("pinning a reply to the thread that was named", () => {
  const ID = "th_01M21192SC68S0SCVYQ11MN3VJ";
  const OTHER = "th_01M22C3CMZKVXRJ1NKAHZ7WE81";

  test("ids are picked out of the request", () => {
    expect([...threadIDsIn(`please reply to ${ID} today`)]).toEqual([ID]);
    expect(threadIDsIn("reply to the SSO one").size).toBe(0);
  });

  /**
   * The failure this exists for. Told to reply to an id it could not use, the model listed the
   * queue and replied to an unrelated customer, and no prompt wording stopped it reliably.
   */
  test("a different thread is refused when one was named", () => {
    const result = mayReplyTo(OTHER, new Set([OTHER]), new Set(["th_01NOTAREALTHREADID0000000"]));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("not the thread to act on");
  });

  test("the named thread is allowed when it is also reachable", () => {
    expect(mayReplyTo(ID, new Set([ID]), new Set([ID])).ok).toBe(true);
  });

  // Naming nothing leaves the reachable set as the only gate, which is the queue-triage case.
  test("with no id named, reachability alone decides", () => {
    expect(mayReplyTo(ID, new Set([ID]), new Set()).ok).toBe(true);
    expect(mayReplyTo(ID, new Set(), new Set()).ok).toBe(false);
  });
});

describe("the thread link in the preamble", () => {
  // Given only an id the model produced app.nairi.ai/threads/... and example.com. It needs a link.
  test("the real link goes in when there is one", () => {
    const prompt = promptWithContext("answer this", {
      discussionID: "d", threadID: "th_1",
      threadURL: "https://app.plain.com/workspace/w_1/thread/th_1/",
    });
    expect(prompt).toContain("https://app.plain.com/workspace/w_1/thread/th_1/");
  });

  test("no link is mentioned when there is none", () => {
    const prompt = promptWithContext("answer this", { discussionID: "d", threadID: "th_1", threadURL: null });
    expect(prompt).not.toContain("Its link is");
    expect(prompt).toContain("th_1");
  });
});
