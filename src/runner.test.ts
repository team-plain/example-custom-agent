import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { Execution, Executor, ExecutionRequest } from "./executor.ts";
import type { RuntimeName } from "./runtime.ts";
import { Runner } from "./runner.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Records the argv it is handed instead of running anything, so a test can assert on the exact
// command a turn would run without a CLI, a sandbox or a network.
class RecordingExecutor implements Executor {
  readonly calls: ExecutionRequest[] = [];
  readonly prepared: string[] = [];
  closed = 0;
  /** Set to make the next prepare() report a place with no CLI state, as a new sandbox would. */
  fresh = false;

  constructor(
    readonly runtime: RuntimeName,
    private readonly stdout: string,
  ) {}

  async prepare(discussionID: string): Promise<{ fresh: boolean }> {
    this.prepared.push(discussionID);
    const fresh = this.fresh;
    this.fresh = false;
    return { fresh };
  }

  async run(request: ExecutionRequest): Promise<Execution> {
    this.calls.push(request);
    return { stdout: this.stdout, stderr: "", exitCode: 0 };
  }

  async close(): Promise<void> {
    this.closed += 1;
  }

  get lastArgv(): string[] {
    const last = this.calls.at(-1);
    if (last === undefined) throw new Error("nothing ran");
    return last.argv;
  }
}

function claudeReply(text: string, sessionID: string): string {
  return JSON.stringify({ result: text, session_id: sessionID, is_error: false });
}

/** A fresh id per test so the on-disk session store never leaks between them. */
function discussionID(): string {
  return `disc_test_${crypto.randomUUID().replace(/-/g, "")}`;
}

const used: string[] = [];

function track(id: string): string {
  used.push(id);
  return id;
}

afterEach(async () => {
  await Promise.all(
    used.splice(0).map((id) =>
      rm(join(import.meta.dir, "..", "sessions", "claude", `${id}.txt`), { force: true }),
    ),
  );
});

describe("command construction", () => {
  test("the first turn opens a new session and carries the instructions", async () => {
    const executor = new RecordingExecutor("local", claudeReply("hi", "ignored"));
    const runner = await Runner.create("claude", executor);
    const id = track(discussionID());

    expect(await runner.ask(id, "what is broken?")).toBe("hi");

    const argv = executor.lastArgv;
    expect(argv[0]).toBe("claude");
    expect(argv).toContain("-p");
    expect(argv).toContain("--session-id");
    expect(argv).not.toContain("--resume");
    expect(argv[argv.indexOf("--session-id") + 1]).toMatch(UUID);

    // The prompt is the last argument, and the first turn is what carries prompt.md.
    const prompt = argv.at(-1) ?? "";
    expect(prompt.endsWith("what is broken?")).toBe(true);
    expect(prompt.length).toBeGreaterThan("what is broken?".length);
  });

  test("a later turn resumes the stored session and drops the instructions", async () => {
    const executor = new RecordingExecutor("local", claudeReply("hi", "ignored"));
    const runner = await Runner.create("claude", executor);
    const id = track(discussionID());

    await runner.ask(id, "first");
    const opened = executor.lastArgv[executor.lastArgv.indexOf("--session-id") + 1];

    expect(await runner.isResuming(id)).toBe(true);
    await runner.ask(id, "second");

    const argv = executor.lastArgv;
    expect(argv).toContain("--resume");
    expect(argv).not.toContain("--session-id");
    expect(argv[argv.indexOf("--resume") + 1]).toBe(opened);
    expect(argv.at(-1)).toBe("second");
  });

  // The claim the sandbox runtime rests on: same command, different place.
  test("the sandbox runtime builds the identical command", async () => {
    const id = track(discussionID());
    const local = new RecordingExecutor("local", claudeReply("hi", "ignored"));
    const sandbox = new RecordingExecutor("vercel-sandbox", claudeReply("hi", "ignored"));

    await (await Runner.create("claude", local)).ask(id, "same question");
    const localArgv = local.lastArgv;
    await rm(join(import.meta.dir, "..", "sessions", "claude", `${id}.txt`), { force: true });
    await (await Runner.create("claude", sandbox)).ask(id, "same question");

    // Only the invented session id differs, because each run mints its own.
    const strip = (argv: string[]) => argv.filter((arg) => !UUID.test(arg));
    expect(strip(sandbox.lastArgv)).toEqual(strip(localArgv));
    expect(sandbox.calls[0]?.discussionID).toBe(id);
  });

  // A sandbox that expired is replaced by an empty one, and the stored session id then points at
  // nothing. Resuming it would fail every turn, so a fresh place has to start a new session.
  test("a fresh place ignores the stored session instead of resuming into nothing", async () => {
    const executor = new RecordingExecutor("vercel-sandbox", claudeReply("hi", "ignored"));
    const runner = await Runner.create("claude", executor);
    const id = track(discussionID());

    await runner.ask(id, "first");
    const opened = executor.lastArgv[executor.lastArgv.indexOf("--session-id") + 1];
    expect(await runner.isResuming(id)).toBe(true);

    executor.fresh = true;
    await runner.ask(id, "after the sandbox was replaced");

    const argv = executor.lastArgv;
    expect(argv).not.toContain("--resume");
    expect(argv).toContain("--session-id");
    expect(argv[argv.indexOf("--session-id") + 1]).not.toBe(opened);

    // The turn stores the new id, so the turn after this one resumes again.
    executor.fresh = false;
    await runner.ask(id, "and the next one");
    expect(executor.lastArgv).toContain("--resume");
  });

  test("prepare runs before the command is built, once per turn", async () => {
    const executor = new RecordingExecutor("local", claudeReply("hi", "ignored"));
    const runner = await Runner.create("claude", executor);
    const id = track(discussionID());

    await runner.ask(id, "one");
    await runner.ask(id, "two");

    expect(executor.prepared).toEqual([id, id]);
  });

  test("the discussion id reaches the executor, so a sandbox can be scoped to it", async () => {
    const executor = new RecordingExecutor("local", claudeReply("hi", "ignored"));
    const runner = await Runner.create("claude", executor);
    const id = track(discussionID());

    await runner.ask(id, "hello");

    expect(executor.calls).toHaveLength(1);
    expect(executor.calls[0]?.discussionID).toBe(id);
    expect(executor.calls[0]?.signal.aborted).toBe(false);
  });
});

describe("runtime selection", () => {
  test("only Claude Code runs in a sandbox", async () => {
    const sandbox = new RecordingExecutor("vercel-sandbox", "");
    await expect(Runner.create("codex", sandbox)).rejects.toThrow(/only runs with AGENT_RUNTIME=local/);
    await expect(Runner.create("opencode", sandbox)).rejects.toThrow(/only runs with AGENT_RUNTIME=local/);
  });

  test("Claude Code is accepted in both runtimes", async () => {
    expect((await Runner.create("claude", new RecordingExecutor("local", ""))).name).toBe("claude");
    expect((await Runner.create("claude", new RecordingExecutor("vercel-sandbox", ""))).name).toBe(
      "claude",
    );
  });

  test("closing the runner releases the executor", async () => {
    const executor = new RecordingExecutor("local", "");
    const runner = await Runner.create("claude", executor);
    await runner.close();
    expect(executor.closed).toBe(1);
  });
});
