import { describe, expect, test } from "bun:test";
import {
  surfaceFor,
  shouldAnswerDiscussion,
  shouldAnswerThread,
  timelineEntryIDOf,
  type DiscussionPayload,
  type ThreadPayload,
} from "./serve.ts";

const ME = "mu_agent";

/**
 * Fixtures naming only the fields these decisions read.
 *
 * Cast once, here: the production code uses the SDK types unaltered, so the compiler still
 * enforces the real shape everywhere it matters.
 */
function discussion(
  overrides: Record<string, unknown> = {},
  message: Record<string, unknown> = {},
): DiscussionPayload {
  return {
    eventType: "discussion.message_created",
    discussion: { id: "disc_1", type: "AGENT_SESSION", status: "OPEN", agent: { id: ME }, ...overrides },
    message: { id: "msg_1", type: "OUTBOUND", text: "hello", ...message },
  } as unknown as DiscussionPayload;
}

function thread(assignee: unknown, extra: Record<string, unknown> = {}): ThreadPayload {
  return {
    eventType: "thread.email_received",
    thread: { id: "th_1", assignee, customer: { id: "c_1" } },
    email: { timelineEntryId: "te_email" },
    ...extra,
  } as unknown as ThreadPayload;
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

  // EMAIL and SLACK discussions are conversations with people, not agent sessions.
  test("ignores a non-agent discussion type", () => {
    expect(shouldAnswerDiscussion(discussion({ type: "EMAIL" }), ME)).toBe(false);
  });

  test("ignores a resolved discussion", () => {
    expect(shouldAnswerDiscussion(discussion({ status: "RESOLVED" }), ME)).toBe(false);
  });
});

describe("deciding whether to act on a thread", () => {
  test("acts only when the thread is assigned to this agent", () => {
    expect(shouldAnswerThread(thread({ id: ME }), ME)).toBe(true);
  });

  test("ignores a thread assigned to someone else", () => {
    expect(shouldAnswerThread(thread({ id: "u_person" }), ME)).toBe(false);
  });

  // Unassigned is not this agent's work: a workflow assigns it when it should be.
  test("ignores an unassigned thread", () => {
    expect(shouldAnswerThread(thread(null), ME)).toBe(false);
  });

  // The assignee union has an UNKNOWN variant carrying no id, so reading .id blindly would throw.
  test("ignores an assignee of unknown shape rather than throwing", () => {
    expect(shouldAnswerThread(thread({ type: "UNKNOWN" }), ME)).toBe(false);
  });
});

describe("finding the message a suggestion attaches to", () => {
  // The bug this guards: it is nested on the message, not at the payload root. Read from the root
  // it is always undefined, so a gated reply could never attach and the agent silently did nothing.
  test("an email event carries it on email", () => {
    expect(timelineEntryIDOf(thread({ id: ME }))).toBe("te_email");
  });

  test("a chat event carries it on chat", () => {
    const chat = {
      eventType: "thread.chat_received",
      thread: { id: "th_1", assignee: { id: ME }, customer: { id: "c_1" } },
      chat: { timelineEntryId: "te_chat" },
    } as unknown as ThreadPayload;
    expect(timelineEntryIDOf(chat)).toBe("te_chat");
  });

  // These two carry no customer message at all, so there is nothing to attach to.
  test("thread_created and assignment events have none", () => {
    for (const eventType of ["thread.thread_created", "thread.thread_assignment_transitioned"]) {
      const payload = {
        eventType,
        thread: { id: "th_1", assignee: { id: ME }, customer: { id: "c_1" } },
      } as unknown as ThreadPayload;
      expect(timelineEntryIDOf(payload)).toBe(null);
    }
  });
});
