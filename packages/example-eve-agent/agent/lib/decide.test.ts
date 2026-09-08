import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  SeenDeliveries,
  optionIDFor,
  promptFrom,
  shouldAnswer,
  type PlainMessagePayload,
} from "./decide.ts";

const ME = "mu_agent";

function payload(
  discussion: Partial<PlainMessagePayload["discussion"]> = {},
  message: Partial<PlainMessagePayload["message"]> = {},
): PlainMessagePayload {
  return {
    eventType: "discussion.message_created",
    discussion: {
      id: "disc_1",
      type: "AGENT_SESSION",
      status: "OPEN",
      agent: { id: ME },
      ...discussion,
    },
    message: { id: "msg_1", type: "OUTBOUND", text: "hello", ...message },
  };
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

  // Nothing to answer, and sending an empty prompt to the model wastes a turn.
  test("reports whitespace-only content as empty", () => {
    assert.equal(promptFrom(payload({}, { markdown: "   \n ", text: null })), "");
  });
});

describe("optionIDFor", () => {
  test("APPROVED answers the parked request with approve", () => {
    assert.equal(optionIDFor("APPROVED"), "approve");
  });

  // Anything that is not an explicit approval must not run the call.
  test("DENIED and anything unrecognised cancel", () => {
    assert.equal(optionIDFor("DENIED"), "cancel");
    assert.equal(optionIDFor(""), "cancel");
    assert.equal(optionIDFor("SOMETHING_NEW"), "cancel");
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
  // is the accepted trade and the reason this is not production-grade.
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
