import { describe, expect, test } from "bun:test";
import {
  surfaceFor,
  shouldAnswerDiscussion,
  shouldAnswerThread,
  type DiscussionPayload,
  type ThreadPayload,
} from "./serve.ts";

const ME = "mu_agent";

function discussion(overrides: Partial<DiscussionPayload["discussion"]> = {},
  message: Partial<DiscussionPayload["message"]> = {}): DiscussionPayload {
  return {
    eventType: "discussion.message_created",
    discussion: {
      id: "disc_1",
      type: "AGENT_SESSION",
      status: "OPEN",
      agent: { id: ME },
      ...overrides,
    },
    message: { id: "msg_1", type: "OUTBOUND", text: "hello", ...message },
  };
}

function thread(assigneeID: string | null): ThreadPayload {
  return {
    eventType: "thread.email_received",
    thread: {
      id: "th_1",
      assignee: assigneeID === null ? null : { id: assigneeID },
      customer: { id: "c_1" },
    },
    timelineEntryId: "te_1",
  };
}

describe("surface routing", () => {
  test("thread events go to the support surface", () => {
    expect(surfaceFor("thread.thread_created")).toBe("support");
    expect(surfaceFor("thread.email_received")).toBe("support");
    expect(surfaceFor("thread.chat_received")).toBe("support");
    expect(surfaceFor("thread.thread_assignment_transitioned")).toBe("support");
  });

  test("discussion events go to the internal surface", () => {
    expect(surfaceFor("discussion.message_created")).toBe("internal");
    expect(surfaceFor("discussion.tool_call_approval_resolved")).toBe("internal");
  });

  // A target subscribed to more than this package handles must not be treated as either surface.
  test("anything else is ignored rather than guessed at", () => {
    expect(surfaceFor("thread.thread_status_transitioned")).toBe("ignored");
    expect(surfaceFor("customer.created")).toBe("ignored");
    expect(surfaceFor("")).toBe("ignored");
  });
});

describe("deciding whether to answer a discussion", () => {
  test("answers a teammate's message on its own session", () => {
    expect(shouldAnswerDiscussion(discussion(), ME)).toBe(true);
  });

  // The loop guard: the agent's own replies come back as INBOUND.
  test("ignores its own reply coming back", () => {
    expect(shouldAnswerDiscussion(discussion({}, { type: "INBOUND" }), ME)).toBe(false);
  });

  test("ignores a discussion belonging to another agent", () => {
    expect(shouldAnswerDiscussion(discussion({ agent: { id: "mu_other" } }), ME)).toBe(false);
  });

  test("ignores a discussion with no agent at all", () => {
    expect(shouldAnswerDiscussion(discussion({ agent: null }), ME)).toBe(false);
  });

  test("ignores a non-agent discussion type", () => {
    expect(shouldAnswerDiscussion(discussion({ type: "THREAD_DISCUSSION" }), ME)).toBe(false);
  });

  test("ignores a resolved discussion", () => {
    expect(shouldAnswerDiscussion(discussion({ status: "RESOLVED" }), ME)).toBe(false);
  });
});

describe("deciding whether to act on a thread", () => {
  test("acts only when the thread is assigned to this agent", () => {
    expect(shouldAnswerThread(thread(ME), ME)).toBe(true);
  });

  test("ignores a thread assigned to someone else", () => {
    expect(shouldAnswerThread(thread("u_person"), ME)).toBe(false);
  });

  // Unassigned is not this agent's work: a workflow assigns it when it should be.
  test("ignores an unassigned thread", () => {
    expect(shouldAnswerThread(thread(null), ME)).toBe(false);
  });
});
