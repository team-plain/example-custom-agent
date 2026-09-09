import { test, describe as suite } from "node:test";
import assert from "node:assert/strict";
import { describe } from "../agent/channels/plain.ts";

// This string is the whole timeline row: Plain's tool call has no separate title field, and a
// support team reads it. A JSON dump of the arguments is the shape of the call, not what it did.
suite("the tool call row", () => {
  test("reads as a sentence, not as a serialised call", () => {
    const row = describe({ toolName: "search_knowledge", input: { query: "slack setup" } });
    assert.equal(row, 'searched the knowledge base for "slack setup"');
  });

  test("names the thread a read was on", () => {
    const row = describe({ toolName: "read_customer_thread", input: { threadId: "th_9" } });
    assert.equal(row, "read thread th_9");
  });

  // The draft is on the approval card beside this row. Naming it here too showed the reviewer the
  // same reply twice, the second copy cut off mid-sentence.
  test("leaves the draft off a reply", () => {
    const row = describe({
      toolName: "reply_to_customer",
      input: { threadId: "th_9", message: "Settings, then Integrations, then Connect Slack." },
    });
    assert.ok(!row.includes("Settings"));
    assert.ok(row.includes("th_9"));
  });

  test("falls back to the raw call for a tool it does not know", () => {
    const row = describe({ toolName: "page_oncall", input: { who: "someone" } });
    assert.ok(row.startsWith("page_oncall("));
  });
});
