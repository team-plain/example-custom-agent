import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  PendingApprovals,
  SeenDeliveries,
  approvalKey,
  optionIDFor,
  promptFrom,
  shouldAnswer,
  type MessageCreated,
} from "../agent/lib/decide.ts";

const ME = "mu_agent";

/**
 * A fixture naming only the fields these decisions read.
 *
 * Cast once, here, rather than in the channel: the production code uses the SDK type unaltered, so
 * the compiler still enforces the real shape everywhere it matters.
 */
function payload(discussion: Record<string, unknown> = {}, message: Record<string, unknown> = {}) {
  return {
    eventType: "discussion.message_created",
    discussion: { id: "disc_1", type: "AGENT_SESSION", status: "OPEN", agent: { id: ME }, ...discussion },
    message: { id: "msg_1", type: "OUTBOUND", text: "hello", ...message },
  } as unknown as MessageCreated;
}

describe("shouldAnswer", () => {
  test("answers a teammate's message on its own session", () => {
    assert.equal(shouldAnswer(payload(), ME), true);
  });

  // The loop guard. Without it the agent answers its own replies forever.
  test("ignores its own reply coming back as INBOUND", () => {
    assert.equal(shouldAnswer(payload({}, { type: "INBOUND" }), ME), false);
  });

  test("ignores a session belonging to another agent", () => {
    assert.equal(shouldAnswer(payload({ agent: { id: "mu_other" } }), ME), false);
  });

  test("ignores a session with no agent", () => {
    assert.equal(shouldAnswer(payload({ agent: null }), ME), false);
  });

  test("ignores a discussion that is not an agent session", () => {
    assert.equal(shouldAnswer(payload({ type: "THREAD_DISCUSSION" }), ME), false);
  });

  test("ignores a resolved discussion", () => {
    assert.equal(shouldAnswer(payload({ status: "RESOLVED" }), ME), false);
  });
});

describe("promptFrom", () => {
  test("prefers markdown over text", () => {
    assert.equal(promptFrom(payload({}, { markdown: "**hi**", text: "hi" })), "**hi**");
  });

  test("falls back to text when there is no markdown", () => {
    assert.equal(promptFrom(payload({}, { markdown: null })), "hello");
  });

  // Nothing to answer, and an empty prompt wastes a model turn.
  test("reports whitespace-only content as empty", () => {
    assert.equal(promptFrom(payload({}, { markdown: "   \n ", text: null })), "");
  });
});

describe("optionIDFor", () => {
  test("APPROVED answers the parked request with approve", () => {
    assert.equal(optionIDFor("APPROVED"), "approve");
  });

  test("DENIED cancels it", () => {
    assert.equal(optionIDFor("DENIED"), "cancel");
  });

  // The one that matters: an unknown status is not a denial. Cancelling here would refuse a call
  // nobody refused, so the request must stay parked instead.
  test("UNKNOWN_APPROVAL_STATUS resolves nothing", () => {
    assert.equal(optionIDFor("UNKNOWN_APPROVAL_STATUS"), undefined);
  });
});

describe("approvalKey", () => {
  // Plain guarantees toolCallId within one discussion only, so the same id in two discussions
  // must not collide and send an approval to the wrong parked request.
  test("the same tool call in two discussions gets different keys", () => {
    assert.notEqual(approvalKey("disc_1", "call_1"), approvalKey("disc_2", "call_1"));
  });

  test("the same pair is stable", () => {
    assert.equal(approvalKey("disc_1", "call_1"), approvalKey("disc_1", "call_1"));
  });
});

describe("SeenDeliveries", () => {
  test("reports a repeat delivery and lets the first through", () => {
    const seen = new SeenDeliveries();
    assert.equal(seen.check("msg_1"), false);
    assert.equal(seen.check("msg_1"), true);
    assert.equal(seen.check("msg_2"), false);
  });

  // Bounded so a long-running process cannot grow it without limit. Clearing loses history, which
  // is the accepted trade and why this is not production-grade.
  test("clears rather than growing past its limit", () => {
    const seen = new SeenDeliveries(2);
    seen.check("a");
    seen.check("b");
    assert.equal(seen.size, 2);
    seen.check("c");
    assert.equal(seen.size, 1);
    assert.equal(seen.check("a"), false);
  });
});

describe("PendingApprovals", () => {
  test("a discussion with no card open can settle its status", () => {
    const pending = new PendingApprovals();
    assert.equal(pending.canSettleStatus("disc_1"), true);
  });

  // The bug this guards: eve emits session.waiting while the card is still up, and Plain rejects
  // an agent status during a pending approval, so settling there fails the whole gated turn.
  test("a discussion with a card open cannot", () => {
    const pending = new PendingApprovals();
    pending.opened("disc_1");
    assert.equal(pending.canSettleStatus("disc_1"), false);
  });

  test("one discussion's open card does not block another", () => {
    const pending = new PendingApprovals();
    pending.opened("disc_1");
    assert.equal(pending.canSettleStatus("disc_2"), true);
  });

  test("settling reopens the door", () => {
    const pending = new PendingApprovals();
    pending.opened("disc_1");
    pending.settled("disc_1");
    assert.equal(pending.canSettleStatus("disc_1"), true);
  });
});
