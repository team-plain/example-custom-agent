import { describe, test } from "node:test";
import assert from "node:assert/strict";

import replyToCustomer from "../agent/tools/reply_to_customer.ts";
import searchKnowledge from "../agent/tools/search_knowledge.ts";
import readCustomerThread from "../agent/tools/read_customer_thread.ts";
import listThreadQueue from "../agent/tools/list_thread_queue.ts";
import searchThreads from "../agent/tools/search_threads.ts";
import { forgetThreads, isKnownThread, refuseThread, rememberThread } from "../agent/lib/client.ts";

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
