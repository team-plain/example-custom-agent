import { mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { truncate } from "./config.ts";
import type { Provider, ProviderName } from "./providers.ts";
import { PROVIDERS } from "./providers.ts";

const INSTRUCTIONS = `You are a support agent embedded in Plain, a customer support tool.
A member of the support team has asked you something inside a discussion attached to a support thread.
Answer them directly and briefly. Your reply is rendered as markdown in the Plain UI, so use short
paragraphs and lists rather than headings. Never mention that you run in a terminal. If you cannot
answer, say so plainly and say what you would need.`;

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
  ) {}

  static async create(name: ProviderName): Promise<Runner> {
    const provider = PROVIDERS[name];
    if (!Bun.which(provider.bin)) throw new Error(`"${provider.bin}" is not on PATH`);

    await mkdir(WORKDIR, { recursive: true });
    const sessions = await SessionStore.open(join(WORKDIR, `sessions-${name}.json`));
    return new Runner(name, provider, sessions);
  }

  isResuming(discussionID: string): boolean {
    return this.sessions.get(discussionID) !== undefined;
  }

  /** Runs one turn against the discussion's session, resuming it when one already exists. */
  async ask(discussionID: string, prompt: string): Promise<string> {
    const existing = this.sessions.get(discussionID);
    const sessionID = existing ?? randomUUID();
    // Prepended rather than passed as a system prompt: not every CLI has a flag for one, and on
    // later turns the session already carries it.
    const full = existing ? prompt : `${INSTRUCTIONS}\n\n${prompt}`;

    const proc = Bun.spawn([this.provider.bin, ...this.provider.args(full, sessionID, !!existing)], {
      // Home, not the workdir: the agent is meant to reach the whole machine, and starting inside a
      // scratch folder is what makes a run feel confined even when nothing is enforcing it.
      cwd: homedir(),
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
