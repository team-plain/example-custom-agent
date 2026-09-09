import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  PendingApprovals,
  SeenDeliveries,
  approvalKey,
  optionIDFor,
  promptFrom,
  promptWithThread,
  shouldAnswer,
  threadIDOf,
  whyNotAnswering,
  type MessageCreated,
} from "../agent/lib/decide.ts";
import { forgetThreads, isKnownThread, rememberThread } from "../agent/lib/client.ts";

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

describe("threadIDOf", () => {
  test("reads the customer thread off the discussion", () => {
    assert.equal(threadIDOf(payload({ threadId: "th_1" })), "th_1");
  });

  // threadId is nullable on the payload. A discussion opened on nothing has no customer to reply
  // to, and null rather than undefined is what the tools branch on.
  test("is null when the discussion is not on a thread", () => {
    assert.equal(threadIDOf(payload({ threadId: null })), null);
  });
});

describe("promptWithThread", () => {
  test("names the thread and tells the model which tools take it", () => {
    const prompt = promptWithThread("answer this", "th_1");
    assert.match(prompt, /th_1/);
    assert.match(prompt, /read_customer_thread/);
    assert.match(prompt, /answer this/);
  });

  // Said up front so the model does not call a tool that cannot work and then apologise for it.
  test("says so plainly when there is no thread", () => {
    assert.match(promptWithThread("answer this", null), /not attached to a customer thread/);
  });
});

describe("known threads", () => {
  test("a thread is unknown until a webhook delivers it", () => {
    forgetThreads();
    assert.equal(isKnownThread("th_1"), false);
    rememberThread("th_1");
    assert.equal(isKnownThread("th_1"), true);
  });

  // The guard that matters: the id reaches a tool through the prompt, so a model can invent one.
  test("an invented id stays unknown", () => {
    forgetThreads();
    rememberThread("th_1");
    assert.equal(isKnownThread("th_made_up"), false);
  });
});

describe("saying why a delivery was dropped", () => {
  // Silence made a RESOLVED session look identical to a broken agent. Each refusal now names itself.
  test("a resolved discussion says to start a new session", () => {
    const why = whyNotAnswering(payload({ status: "RESOLVED" }), ME);
    assert.match(String(why), /RESOLVED/);
    assert.match(String(why), /new Ask Sidekick session/);
  });

  test("its own reply says the message is not a person's turn", () => {
    assert.match(String(whyNotAnswering(payload({}, { type: "INBOUND" }), ME)), /INBOUND/);
  });

  test("another agent's discussion names the other agent", () => {
    assert.match(String(whyNotAnswering(payload({ agent: { id: "mu_other" } }), ME)), /mu_other/);
  });

  test("null when there is nothing wrong", () => {
    assert.equal(whyNotAnswering(payload(), ME), null);
  });

  // The boolean wrapper has to stay in step with the reason, or one of them is wrong.
  test("shouldAnswer agrees with whyNotAnswering", () => {
    for (const p of [payload(), payload({ status: "RESOLVED" }), payload({}, { type: "INBOUND" })]) {
      assert.equal(shouldAnswer(p, ME), whyNotAnswering(p, ME) === null);
    }
  });
});
