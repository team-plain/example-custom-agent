import { test } from "node:test";
import assert from "node:assert/strict";

// Imports the channel for real, because typecheck passed a version that could not be imported at
// all: a `.js` specifier tsc accepted and Node did not, and a parameter property invalid under
// strip-only mode. Neither is a type error.
test("the Plain channel module loads and exports a channel", async () => {
  const channel = await import("../agent/channels/plain.ts");
  assert.equal(typeof channel.default, "object");
  assert.notEqual(channel.default, null);
});
