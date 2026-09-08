import { mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { truncate } from "./config.ts";
import type { Executor } from "./executor.ts";
import type { Provider, ProviderName } from "./providers.ts";
import { PROVIDERS } from "./providers.ts";

// Both are resolved against the repo, not the working directory, because the agent is meant to be
// started from whatever codebase you want it to look at. Relative paths would break the moment you
// did that.
const ROOT = join(import.meta.dir, "..");

// Read from a file rather than baked in, so changing how the agent answers does not mean editing
// TypeScript. Not every CLI has a system-prompt flag, so this is prepended to the first message of
// a discussion instead; later turns resume a session that already carries it.
const PROMPT_FILE = join(ROOT, "prompt.md");

const SESSIONS_DIR = join(ROOT, "sessions");

const TIMEOUT_MS = 180_000;

// Only Claude Code is installed in the sandbox. The others are left local rather than half
// supported, because a provider that cannot authenticate there fails one turn at a time.
const SANDBOX_PROVIDERS: ProviderName[] = ["claude"];

// A file per discussion inside a directory per provider: two discussions answered at once would
// otherwise race on one shared file, and a codex thread id means nothing to pi.
class SessionStore {
  private constructor(private readonly dir: string) {}

  static async open(dir: string): Promise<SessionStore> {
    await mkdir(dir, { recursive: true });
    return new SessionStore(dir);
  }

  /** The discussion id arrives in a webhook, so it is scrubbed before it is used as a path. */
  private path(discussionID: string): string {
    return join(this.dir, `${discussionID.replace(/[^A-Za-z0-9_-]/g, "")}.txt`);
  }

  async get(discussionID: string): Promise<string | undefined> {
    const file = Bun.file(this.path(discussionID));
    if (!(await file.exists())) return undefined;
    const id = (await file.text()).trim();
    return id === "" ? undefined : id;
  }

  async put(discussionID: string, sessionID: string): Promise<void> {
    await Bun.write(this.path(discussionID), `${sessionID}\n`);
  }

  // delete() throws ENOENT when nothing was stored, which is the ordinary case here.
  async clear(discussionID: string): Promise<void> {
    await Bun.file(this.path(discussionID)).delete().catch(() => undefined);
  }
}

export class Runner {
  private constructor(
    readonly name: ProviderName,
    private readonly provider: Provider,
    private readonly executor: Executor,
    private readonly sessions: SessionStore,
    private readonly instructions: string,
  ) {}

  static async create(
    name: ProviderName,
    executor: Executor,
    // Injectable because a test that hands in a fake executor should not depend on whether this
    // machine happens to have the CLI installed.
    onPath: (bin: string) => boolean = (bin) => Bun.which(bin) !== null,
  ): Promise<Runner> {
    const provider = PROVIDERS[name];
    if (executor.runtime === "vercel-sandbox" && !SANDBOX_PROVIDERS.includes(name)) {
      throw new Error(
        `--provider ${name} only runs with AGENT_RUNTIME=local, not in a sandbox ` +
          `(${SANDBOX_PROVIDERS.join(", ")} do)`,
      );
    }
    // Only the local runtime needs the CLI here. The sandbox has its own PATH, and demanding a
    // local copy would defeat the point of running it elsewhere.
    if (executor.runtime === "local" && !onPath(provider.bin)) {
      throw new Error(`"${provider.bin}" is not on PATH`);
    }

    const prompt = Bun.file(PROMPT_FILE);
    if (!(await prompt.exists())) throw new Error(`${PROMPT_FILE} is missing`);

    const sessions = await SessionStore.open(join(SESSIONS_DIR, name));
    return new Runner(name, provider, executor, sessions, (await prompt.text()).trim());
  }

  /** Releases whatever the runtime holds between turns. */
  async close(): Promise<void> {
    await this.executor.close();
  }

  async isResuming(discussionID: string): Promise<boolean> {
    return (await this.resumableSession(discussionID)) !== undefined;
  }

  // The stored id is only worth resuming if the place holding the CLI's files still has them.
  // Clearing on the spot rather than after the turn is what makes this survive a failed turn or
  // a restart, and it is why the prompt builder and the turn cannot disagree.
  private async resumableSession(discussionID: string): Promise<string | undefined> {
    const { fresh } = await this.executor.prepare(discussionID);
    const stored = await this.sessions.get(discussionID);
    if (!fresh) return stored;
    if (stored !== undefined) await this.sessions.clear(discussionID);
    return undefined;
  }

  private timeoutMessage(): string {
    return `${this.name} timed out after ${TIMEOUT_MS / 1000}s`;
  }

  /** Runs one turn against the discussion's session, resuming it when one already exists. */
  async ask(discussionID: string, prompt: string): Promise<string> {
    const existing = await this.resumableSession(discussionID);
    const sessionID = existing ?? randomUUID();
    const full = existing || this.instructions === ""
      ? prompt
      : `${this.instructions}\n\n${prompt}`;

    // The argv is the whole command, so both runtimes run the same one and only differ in where.
    const argv = [this.provider.bin, ...this.provider.args(full, sessionID, !!existing)];

    // One budget, enforced twice over: the abort stops this side waiting, and the executor
    // kills the process where it actually runs. A killed local run reports an exit code.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    let stdout: string;
    let stderr: string;
    let exitCode: number;
    try {
      ({ stdout, stderr, exitCode } = await this.executor.run({
        discussionID,
        argv,
        signal: controller.signal,
        timeoutMs: TIMEOUT_MS,
      }));
    } catch (err) {
      if (controller.signal.aborted) throw new Error(this.timeoutMessage());
      throw err;
    } finally {
      clearTimeout(timer);
    }

    if (controller.signal.aborted) throw new Error(this.timeoutMessage());
    if (exitCode !== 0) {
      throw new Error(`${this.name} exited with ${exitCode}: ${truncate(stderr.trim(), 500)}`);
    }

    const { text, sessionID: reported } = this.provider.parse(stdout);
    // Never store an empty id: a provider that mints its own and failed to report one would
    // otherwise look resumable, and every later turn would resume nothing.
    const next = this.provider.ownsSessionID ? sessionID : reported;
    if (next) await this.sessions.put(discussionID, next);
    if (text === "") {
      throw new Error(`${this.name} returned no answer: ${truncate(stderr.trim(), 300)}`);
    }
    return text;
  }
}
