import { describe, expect, test } from "bun:test";
import type { DiscussionPayload } from "./serve.ts";
import { shouldAnswerDiscussion, threadIDOf } from "./serve.ts";
import { promptWithContext } from "./agent.ts";

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

  // Said up front so the model does not call a tool that cannot work and then apologise for it.
  test("says so plainly when there is not", () => {
    const prompt = promptWithContext("answer this", { discussionID: "disc_1", threadID: null });
    expect(prompt).toContain("not attached to a customer thread");
  });
});
