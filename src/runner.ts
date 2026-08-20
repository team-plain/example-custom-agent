import { mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { truncate } from "./config.ts";
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

/**
 * Maps a Plain discussion onto a CLI session so a discussion behaves like one conversation instead
 * of a series of unrelated questions. A file per discussion inside a directory per provider: two
 * discussions being answered at once would otherwise race on one shared file, and a codex thread id
 * means nothing to pi.
 */
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
}

export class Runner {
  private constructor(
    readonly name: ProviderName,
    private readonly provider: Provider,
    private readonly sessions: SessionStore,
    private readonly instructions: string,
  ) {}

  static async create(name: ProviderName): Promise<Runner> {
    const provider = PROVIDERS[name];
    if (!Bun.which(provider.bin)) throw new Error(`"${provider.bin}" is not on PATH`);

    const prompt = Bun.file(PROMPT_FILE);
    if (!(await prompt.exists())) throw new Error(`${PROMPT_FILE} is missing`);

    const sessions = await SessionStore.open(join(SESSIONS_DIR, name));
    return new Runner(name, provider, sessions, (await prompt.text()).trim());
  }

  async isResuming(discussionID: string): Promise<boolean> {
    return (await this.sessions.get(discussionID)) !== undefined;
  }

  /** Runs one turn against the discussion's session, resuming it when one already exists. */
  async ask(discussionID: string, prompt: string): Promise<string> {
    const existing = await this.sessions.get(discussionID);
    const sessionID = existing ?? randomUUID();
    const full = existing || this.instructions === ""
      ? prompt
      : `${this.instructions}\n\n${prompt}`;

    // No cwd: the CLI starts in whatever directory this process was launched from, so pointing the
    // agent at a codebase is a matter of running it there. Nothing confines it to that directory.
    const proc = Bun.spawn([this.provider.bin, ...this.provider.args(full, sessionID, !!existing)], {
      env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: "example-custom-agent" },
      stdout: "pipe",
      stderr: "pipe",
    });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, TIMEOUT_MS);

    let stdout: string;
    let stderr: string;
    let exitCode: number;
    try {
      [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
    } finally {
      clearTimeout(timer);
    }

    if (timedOut) throw new Error(`${this.name} timed out after ${TIMEOUT_MS / 1000}s`);
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
