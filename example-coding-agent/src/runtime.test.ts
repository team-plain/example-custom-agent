import { describe, expect, test } from "bun:test";
import { DEFAULT_RUNTIME, isRuntimeName, readRuntime } from "./runtime.ts";

describe("readRuntime", () => {
  test("an unset variable keeps the local runtime", () => {
    expect(readRuntime({})).toBe("local");
    expect(readRuntime({ AGENT_RUNTIME: "" })).toBe("local");
    expect(readRuntime({ AGENT_RUNTIME: "   " })).toBe("local");
    expect(DEFAULT_RUNTIME).toBe("local");
  });

  test("both runtimes are selectable, whitespace and all", () => {
    expect(readRuntime({ AGENT_RUNTIME: "local" })).toBe("local");
    expect(readRuntime({ AGENT_RUNTIME: "vercel-sandbox" })).toBe("vercel-sandbox");
    expect(readRuntime({ AGENT_RUNTIME: " vercel-sandbox " })).toBe("vercel-sandbox");
  });

  // The whole point of the switch: a typo must never quietly run the CLI on the host.
  test("an unrecognised value is refused, not defaulted", () => {
    expect(() => readRuntime({ AGENT_RUNTIME: "sandbox" })).toThrow(/must be one of/);
    expect(() => readRuntime({ AGENT_RUNTIME: "Vercel-Sandbox" })).toThrow(/not "Vercel-Sandbox"/);
  });

  test("isRuntimeName narrows only the two names", () => {
    expect(isRuntimeName("local")).toBe(true);
    expect(isRuntimeName("vercel-sandbox")).toBe(true);
    expect(isRuntimeName("docker")).toBe(false);
  });
});
