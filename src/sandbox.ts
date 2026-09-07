import { Sandbox } from "@vercel/sandbox";
import type { Execution, Executor, ExecutionRequest } from "./executor.ts";

export type SandboxConfig = {
  token: string;
  teamId: string;
  projectId: string;
  /** When set, sandboxes start from this snapshot instead of installing the CLI at first start. */
  snapshotID: string | undefined;
};

// The names match team-plain/agent-sandbox, so the same four values work in both projects.
const CREDENTIAL_VARS = [
  "VERCEL_BEARER_TOKEN",
  "VERCEL_SANDBOX_TEAM_ID",
  "VERCEL_SANDBOX_PROJECT_ID",
] as const;

// Claude Code has no login inside a fresh sandbox, so it authenticates from the environment.
// Only these names cross the boundary, and none of them is ever printed.
const FORWARDED_VARS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"] as const;

const CLI_PACKAGE = "@anthropic-ai/claude-code";

// Already on the base image, and sandbox.mkDir throws when the directory exists.
const WORKDIR = "/vercel/sandbox";

// Comfortably longer than one turn, so a follow-up question lands in a sandbox that is still warm.
const SANDBOX_TIMEOUT_MS = 600_000;

// Matches services: a stopped sandbox resumes from its snapshot for a week before it is collected.
const SNAPSHOT_EXPIRATION_MS = 7 * 24 * 60 * 60 * 1000;

const NAME_PREFIX = "plain-agent";

/**
 * Reads the Vercel credentials, and refuses to start without a way for the CLI to authenticate
 * inside the sandbox. Both failures are startup problems, and both are silent at runtime.
 */
export function loadSandboxConfig(
  env: Record<string, string | undefined> = process.env,
): SandboxConfig {
  const missing = CREDENTIAL_VARS.filter((name) => (env[name] ?? "").trim() === "");
  if (missing.length > 0) {
    throw new Error(`AGENT_RUNTIME=vercel-sandbox needs ${missing.join(", ")} in .env`);
  }

  const authenticated = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"].some(
    (name) => (env[name] ?? "").trim() !== "",
  );
  if (!authenticated) {
    throw new Error(
      "AGENT_RUNTIME=vercel-sandbox needs ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN in .env: " +
        "a sandbox has none of your local logins",
    );
  }

  const snapshotID = (env.VERCEL_SANDBOX_SNAPSHOT_ID ?? "").trim();
  return {
    token: (env.VERCEL_BEARER_TOKEN ?? "").trim(),
    teamId: (env.VERCEL_SANDBOX_TEAM_ID ?? "").trim(),
    projectId: (env.VERCEL_SANDBOX_PROJECT_ID ?? "").trim(),
    snapshotID: snapshotID === "" ? undefined : snapshotID,
  };
}

// A sandbox name reaches a hostname, so it is lowercased and stripped to letters, digits and
// dashes. The digest keeps two discussions apart when that stripping or the length cap collides.
export function sandboxName(discussionID: string): string {
  const slug = discussionID
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  const digest = new Bun.CryptoHasher("sha256").update(discussionID).digest("hex").slice(0, 8);
  return `${NAME_PREFIX}-${slug}-${digest}`;
}

function forwardedEnv(env: Record<string, string | undefined> = process.env): Record<string, string> {
  const forwarded: Record<string, string> = { CLAUDE_CODE_ENTRYPOINT: "example-custom-agent" };
  for (const name of FORWARDED_VARS) {
    const value = (env[name] ?? "").trim();
    if (value !== "") forwarded[name] = value;
  }
  return forwarded;
}

/**
 * One persistent named sandbox per discussion, so the CLI's own session files survive between
 * turns and --resume keeps working. Vercel resumes a stopped one on the next command.
 */
export class SandboxExecutor implements Executor {
  readonly runtime = "vercel-sandbox" as const;

  private readonly open = new Map<string, Promise<Sandbox>>();

  // Discussions whose sandbox this process created and whose first turn has not run yet.
  private readonly created = new Set<string>();

  constructor(private readonly config: SandboxConfig) {}

  async prepare(discussionID: string): Promise<{ fresh: boolean }> {
    const sandbox = await this.resolve(discussionID);

    // Best effort. The sandbox timeout is a session lifetime and not an idle timer, so a turn
    // starting near the end of one could be cut off mid-command. A refusal is survivable: a
    // stopped sandbox resumes with its files on the next turn.
    await sandbox.extendTimeout(SANDBOX_TIMEOUT_MS).catch(() => undefined);

    // Reported once, and only for a sandbox this process created: the turn that follows writes a
    // session into it, and every turn after that has one to resume.
    return { fresh: this.created.delete(discussionID) };
  }

  async run(request: ExecutionRequest): Promise<Execution> {
    try {
      return await this.attempt(request);
    } catch (err) {
      // Evict, never retry. runCommand can fail after the CLI has already started, and running
      // the turn a second time against the same session would duplicate the prompt. The next
      // turn re-resolves, so a handle cannot stay stale for longer than one failure.
      this.open.delete(request.discussionID);
      this.created.delete(request.discussionID);
      throw err;
    }
  }

  async close(): Promise<void> {
    const sandboxes = [...this.open.values()];
    this.open.clear();
    // Stopping is not deleting: a persistent sandbox resumes on the next turn with its files
    // intact. Leaving them running would bill for an idle VM per discussion.
    await Promise.allSettled(sandboxes.map(async (pending) => (await pending).stop()));
  }

  private async attempt({ discussionID, argv, signal }: ExecutionRequest): Promise<Execution> {
    const [cmd, ...args] = argv;
    if (cmd === undefined) throw new Error("the provider produced an empty command");

    const sandbox = await this.resolve(discussionID);
    const finished = await sandbox.runCommand({
      cmd,
      args,
      cwd: WORKDIR,
      env: forwardedEnv(),
      signal,
    });

    const [stdout, stderr] = await Promise.all([finished.stdout(), finished.stderr()]);
    return { stdout, stderr, exitCode: finished.exitCode };
  }

  private resolve(discussionID: string): Promise<Sandbox> {
    const cached = this.open.get(discussionID);
    if (cached) return cached;

    const pending = this.create(discussionID);
    this.open.set(discussionID, pending);
    // A rejected promise must not be cached, or the discussion never recovers.
    pending.catch(() => this.open.delete(discussionID));
    return pending;
  }

  private async create(discussionID: string): Promise<Sandbox> {
    const { token, teamId, projectId, snapshotID } = this.config;
    const shared = {
      token,
      teamId,
      projectId,
      name: sandboxName(discussionID),
      timeout: SANDBOX_TIMEOUT_MS,
      persistent: true,
      snapshotExpiration: SNAPSHOT_EXPIRATION_MS,
      // Fires only on a genuine create, not on a retrieve and not on a resume. Nothing may throw
      // in here: getOrCreate swallows it. Recording the fact is all this does.
      onCreate: async () => {
        this.created.add(discussionID);
      },
    };

    const sandbox =
      snapshotID === undefined
        ? await Sandbox.getOrCreate({ ...shared, runtime: "node24" })
        : await Sandbox.getOrCreate({
            ...shared,
            source: { type: "snapshot", snapshotId: snapshotID },
          });

    await ensureCli(sandbox);
    return sandbox;
  }
}

/**
 * Installs the CLI unless it is already there, once per sandbox handle. Deliberately not the
 * getOrCreate `onCreate` hook: the SDK swallows what that hook throws, so a failed install would
 * surface one turn at a time as "executable file not found".
 */
async function ensureCli(sandbox: Sandbox): Promise<void> {
  if (await onPath(sandbox)) return;

  const install = await sandbox.runCommand({
    cmd: "npm",
    args: ["install", "-g", CLI_PACKAGE, "--no-fund", "--no-audit"],
  });
  if (install.exitCode !== 0) {
    throw new Error(`could not install ${CLI_PACKAGE} in the sandbox: ${await install.stderr()}`);
  }

  // A snapshot that was built without the CLI lands here too, and this is where it says so.
  if (!(await onPath(sandbox))) {
    throw new Error(`installed ${CLI_PACKAGE} but "claude" is still not on the sandbox PATH`);
  }
}

async function onPath(sandbox: Sandbox): Promise<boolean> {
  const probe = await sandbox.runCommand({ cmd: "which", args: ["claude"] });
  return probe.exitCode === 0;
}
