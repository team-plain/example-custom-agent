import { test } from "node:test";
import assert from "node:assert/strict";

/**
 * Imports the channel for real.
 *
 * This exists because typecheck passed a version of this file that could not be imported at all:
 * `#lib/plain.js` resolved for tsc and not for Node, and a constructor parameter property is
 * invalid under Node's strip-only TypeScript mode. Neither is a type error, so only loading the
 * module finds them.
 */
test("the Plain channel module loads and exports a channel", async () => {
  const channel = await import("./plain.ts");
  assert.equal(typeof channel.default, "object");
  assert.notEqual(channel.default, null);
});
