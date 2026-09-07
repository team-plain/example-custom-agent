import type { RuntimeName } from "./runtime.ts";

export type Execution = { stdout: string; stderr: string; exitCode: number };

export type ExecutionRequest = {
  /** Scopes whatever the runtime keeps between turns. One sandbox per discussion, not per turn. */
  discussionID: string;
  /** The provider's own argv, built once and identical in every runtime. */
  argv: string[];
  /** Aborted when the turn runs past its timeout. */
  signal: AbortSignal;
  /** The same budget as a number, for runtimes that enforce it where the process actually runs. */
  timeoutMs: number;
};

/** Runs one turn's CLI command and collects its output, wherever that command runs. */
export type Executor = {
  readonly runtime: RuntimeName;
  /**
   * Readies the place this turn will run in, before the command is built. `fresh` means nothing
   * the CLI wrote on an earlier turn survives there, so a stored session id can no longer be
   * resumed and the turn has to start a new one.
   */
  prepare(discussionID: string): Promise<{ fresh: boolean }>;
  run(request: ExecutionRequest): Promise<Execution>;
  /** Releases what this executor holds. Called on shutdown, once. */
  close(): Promise<void>;
};

export class LocalExecutor implements Executor {
  readonly runtime = "local" as const;

  // The CLI keeps its sessions on this machine, so they outlive any one turn.
  async prepare(): Promise<{ fresh: boolean }> {
    return { fresh: false };
  }

  async run({ argv, signal }: ExecutionRequest): Promise<Execution> {
    // No cwd: the CLI starts in whatever directory this process was launched from, so pointing
    // the agent at a codebase is a matter of running it there. Nothing confines it to that
    // directory, which is why the sandbox runtime exists.
    const proc = Bun.spawn(argv, {
      env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: "example-custom-agent" },
      stdout: "pipe",
      stderr: "pipe",
    });

    const kill = () => proc.kill();
    signal.addEventListener("abort", kill, { once: true });

    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      return { stdout, stderr, exitCode };
    } finally {
      signal.removeEventListener("abort", kill);
    }
  }

  async close(): Promise<void> {}
}
