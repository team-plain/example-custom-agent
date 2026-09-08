import { describe, expect, test } from "bun:test";
import { loadSandboxConfig, sandboxName } from "./sandbox.ts";

const CREDENTIALS = {
  VERCEL_BEARER_TOKEN: "token",
  VERCEL_SANDBOX_TEAM_ID: "team",
  VERCEL_SANDBOX_PROJECT_ID: "project",
  ANTHROPIC_API_KEY: "key",
};

describe("sandboxName", () => {
  test("one discussion always maps to the same sandbox", () => {
    expect(sandboxName("disc_01ABC")).toBe(sandboxName("disc_01ABC"));
  });

  test("the name is a usable hostname label", () => {
    const name = sandboxName("disc_01ABCdef!!GHI");
    expect(name).toMatch(/^[a-z0-9-]+$/);
    expect(name.startsWith("-")).toBe(false);
    expect(name.endsWith("-")).toBe(false);
    expect(name.length).toBeLessThanOrEqual(63);
  });

  // Stripping and the length cap both throw away characters, so the digest is what keeps two
  // discussions in separate sandboxes.
  test("ids that survive stripping identically still get their own sandbox", () => {
    expect(sandboxName("disc_ABC")).not.toBe(sandboxName("disc-abc"));
    const long = "d".repeat(40);
    expect(sandboxName(`${long}1`)).not.toBe(sandboxName(`${long}2`));
  });
});

describe("loadSandboxConfig", () => {
  test("it reads the four Vercel values", () => {
    const config = loadSandboxConfig({ ...CREDENTIALS, VERCEL_SANDBOX_SNAPSHOT_ID: "snap_1" });
    expect(config).toEqual({
      token: "token",
      teamId: "team",
      projectId: "project",
      snapshotID: "snap_1",
    });
  });

  test("no snapshot is a supported setup, not a missing value", () => {
    expect(loadSandboxConfig(CREDENTIALS).snapshotID).toBeUndefined();
    expect(loadSandboxConfig({ ...CREDENTIALS, VERCEL_SANDBOX_SNAPSHOT_ID: "  " }).snapshotID)
      .toBeUndefined();
  });

  test("every missing Vercel credential is named at once", () => {
    expect(() => loadSandboxConfig({ ANTHROPIC_API_KEY: "key" })).toThrow(
      /VERCEL_BEARER_TOKEN, VERCEL_SANDBOX_TEAM_ID, VERCEL_SANDBOX_PROJECT_ID/,
    );
  });

  // A sandbox carries none of the local logins, so this would fail one opaque turn at a time.
  test("it refuses to start with no way for the CLI to authenticate", () => {
    const { ANTHROPIC_API_KEY, ...rest } = CREDENTIALS;
    expect(() => loadSandboxConfig(rest)).toThrow(/ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN/);
    expect(loadSandboxConfig({ ...rest, ANTHROPIC_AUTH_TOKEN: "gateway" }).token).toBe("token");
  });
});
