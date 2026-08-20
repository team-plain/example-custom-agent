import { mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { truncate } from "./config.ts";
import type { Provider, ProviderName } from "./providers.ts";
import { PROVIDERS } from "./providers.ts";

// Read from a file rather than baked in, so changing how the agent answers does not mean editing
// TypeScript. Not every CLI has a system-prompt flag, so this is prepended to the first message of
// a discussion instead; later turns resume a session that already carries it.
const PROMPT_FILE = "./prompt.md";

const WORKDIR = "./workdir";

const TIMEOUT_MS = 180_000;

/**
 * Maps a Plain discussion onto a CLI session so a discussion behaves like one conversation instead
 * of a series of unrelated questions. One file per provider: the ids are not interchangeable, and
 * handing a codex thread id to pi would fail every turn after a provider switch.
 */
class SessionStore {
  private ids: Record<string, string> = {};

  private constructor(private readonly path: string) {}

  static async open(path: string): Promise<SessionStore> {
    const store = new SessionStore(path);
    const file = Bun.file(path);
    if (await file.exists()) {
      try {
        store.ids = (await file.json()) as Record<string, string>;
      } catch {
        // A corrupt file is not worth failing a run over: the next turn just starts a new session.
      }
    }
    return store;
  }

  get(discussionID: string): string | undefined {
    return this.ids[discussionID];
  }

  async put(discussionID: string, sessionID: string): Promise<void> {
    this.ids[discussionID] = sessionID;
    await Bun.write(this.path, `${JSON.stringify(this.ids, null, 2)}\n`);
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

    await mkdir(WORKDIR, { recursive: true });
    const sessions = await SessionStore.open(join(WORKDIR, `sessions-${name}.json`));
    return new Runner(name, provider, sessions, (await prompt.text()).trim());
  }

  isResuming(discussionID: string): boolean {
    return this.sessions.get(discussionID) !== undefined;
  }

  /** Runs one turn against the discussion's session, resuming it when one already exists. */
  async ask(discussionID: string, prompt: string): Promise<string> {
    const existing = this.sessions.get(discussionID);
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
