import { describe, test } from "node:test";
import assert from "node:assert/strict";

import replyToCustomer from "../agent/tools/reply_to_customer.ts";
import searchKnowledge from "../agent/tools/search_knowledge.ts";
import readCustomerThread from "../agent/tools/read_customer_thread.ts";
import listThreadQueue from "../agent/tools/list_thread_queue.ts";
import searchThreads from "../agent/tools/search_threads.ts";
import {
  forgetRequestedThreads,
  forgetThreads,
  isKnownThread,
  mayReplyTo,
  refuseThread,
  rememberRequestedThreads,
  rememberThread,
  threadIDsIn,
} from "../agent/lib/client.ts";

/**
 * The gate is one line of config, so a refactor can drop it and every other test still passes.
 * These assert the shape the whole design rests on rather than any behaviour.
 */
describe("which tools are gated", () => {
  test("reply_to_customer needs an approval", () => {
    assert.ok(replyToCustomer.approval, "reply_to_customer must declare an approval");
  });

  // Reads are not gated on purpose: a card per search would make the gate noise people click past.
  test("the reads are not gated", () => {
    assert.equal(searchKnowledge.approval, undefined);
    assert.equal(readCustomerThread.approval, undefined);
    assert.equal(listThreadQueue.approval, undefined);
    assert.equal(searchThreads.approval, undefined);
  });
});

// inputSchema is declared as a union that also covers plain JSON Schema, so `shape` needs proving
// rather than asserting. These tools all use Zod, so a missing shape is itself a failure.
function inputKeys(schema: unknown): string[] {
  if (schema === null || typeof schema !== "object" || !("shape" in schema)) {
    throw new Error("expected a Zod object schema");
  }
  return Object.keys((schema as { shape: Record<string, unknown> }).shape).sort();
}

describe("tool inputs", () => {
  test("reply_to_customer takes a thread id and a message", () => {
    assert.deepEqual(inputKeys(replyToCustomer.inputSchema), ["message", "threadId"]);
  });

  test("search_knowledge takes a query", () => {
    assert.deepEqual(inputKeys(searchKnowledge.inputSchema), ["query"]);
  });
});

describe("the reachable-thread guard", () => {
  test("an id nothing handed over is refused", () => {
    forgetThreads();
    assert.equal(isKnownThread("th_invented"), false);
    const refusal = refuseThread("th_invented");
    assert.equal(refusal.ok, false);
    assert.match(refusal.reason, /search_threads/);
  });

  // The widening the queue tools buy: an id they returned becomes reachable, and only then.
  test("a discovered id becomes reachable", () => {
    forgetThreads();
    rememberThread("th_from_queue");
    assert.equal(isKnownThread("th_from_queue"), true);
    assert.equal(isKnownThread("th_other"), false);
  });
});

describe("the queue tools", () => {
  test("list_thread_queue defaults to the TODO queue", () => {
    const status = inputKeys(listThreadQueue.inputSchema);
    assert.deepEqual(status, ["status"]);
  });

  test("search_threads takes a query", () => {
    assert.deepEqual(inputKeys(searchThreads.inputSchema), ["query"]);
  });
});

describe("pinning a reply to the thread that was named", () => {
  const ID = "th_01M21192SC68S0SCVYQ11MN3VJ";
  const OTHER = "th_01M22C3CMZKVXRJ1NKAHZ7WE81";

  test("ids are picked out of the request", () => {
    assert.deepEqual([...threadIDsIn(`reply to ${ID} please`)], [ID]);
    assert.equal(threadIDsIn("reply to the SSO one").size, 0);
  });

  /**
   * The failure this exists for. Told to reply to an id it could not use, the model listed the
   * queue and replied to an unrelated customer, and no instruction wording stopped it reliably.
   */
  test("a different thread is refused when one was named", () => {
    forgetThreads();
    forgetRequestedThreads();
    rememberThread(OTHER);
    rememberRequestedThreads("please reply to th_01NOTAREALTHREADID0000000");
    const result = mayReplyTo(OTHER);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, /not the thread to reply on/);
  });

  test("the named thread is allowed when a webhook delivered it", () => {
    forgetThreads();
    forgetRequestedThreads();
    rememberThread(ID);
    rememberRequestedThreads(`reply to ${ID}`);
    assert.equal(mayReplyTo(ID).ok, true);
  });

  // Naming nothing leaves reachability as the only gate, which is the queue-triage case.
  test("with no id named, reachability alone decides", () => {
    forgetThreads();
    forgetRequestedThreads();
    assert.equal(mayReplyTo(ID).ok, false);
    rememberThread(ID);
    assert.equal(mayReplyTo(ID).ok, true);
  });
});
