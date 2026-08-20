import { mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { truncate } from "./config.ts";

const SYSTEM_PROMPT_ADDITION = `You are a support agent embedded in Plain, a customer support tool.
A member of the support team has asked you something inside a discussion attached to a support thread.
Answer them directly and briefly. Your reply is rendered as markdown in the Plain UI, so use short
paragraphs and lists rather than headings. Never mention that you are Claude Code or that you run in
a terminal. If you cannot answer, say so plainly and say what you would need.`;

// Claude runs unconfined on purpose: auto mode approves its own tool calls and the sandbox is off, so
// a turn can read and change anything the user running this process can. Nothing here contains the
// blast radius, so treat every discussion message as untrusted input that reaches your machine.
const NO_SANDBOX_SETTINGS = JSON.stringify({ sandbox: { enabled: false } });

/** Every path under it. --add-dir is what lifts tool access beyond the directory Claude starts in. */
const WHOLE_FILESYSTEM = "/";

const WORKDIR = "./workdir";

const TIMEOUT_MS = 180_000;

type ClaudeResult = {
  type?: string;
  subtype?: string;
  result?: string;
  session_id?: string;
  is_error?: boolean;
  num_turns?: number;
  usage?: { input_tokens?: number; output_tokens?: number };
};

/**
 * Maps a Plain discussion onto a Claude Code session so a discussion behaves like one conversation
 * instead of a series of unrelated questions.
 */
export class SessionStore {
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

export class ClaudeRunner {
  private constructor(private readonly sessions: SessionStore) {}

  static async create(): Promise<ClaudeRunner> {
    await mkdir(WORKDIR, { recursive: true });
    return new ClaudeRunner(await SessionStore.open(join(WORKDIR, "sessions.json")));
  }

  isResuming(discussionID: string): boolean {
    return this.sessions.get(discussionID) !== undefined;
  }

  /** Runs one turn against the discussion's session, resuming it when one already exists. */
  async ask(discussionID: string, prompt: string): Promise<string> {
    const existing = this.sessions.get(discussionID);
    const sessionID = existing ?? randomUUID();

    const args = ["-p", "--output-format", "json"];
    if (existing) {
      args.push("--resume", sessionID);
    } else {
      args.push("--session-id", sessionID, "--append-system-prompt", SYSTEM_PROMPT_ADDITION);
    }
    // Auto mode lets Claude approve its own tool calls, which is the only way a headless turn gets
    // to use tools at all: with the default mode every prompt is a denial nobody is there to answer.
    args.push("--permission-mode", "auto");
    args.push("--add-dir", WHOLE_FILESYSTEM);
    args.push("--settings", NO_SANDBOX_SETTINGS);
    args.push(prompt);

    const proc = Bun.spawn(["claude", ...args], {
      // Home, not the workdir: the agent is meant to reach the whole machine, and starting inside a
      // scratch folder is what makes a run feel confined even when nothing is enforcing it.
      cwd: homedir(),
      env: {
        ...process.env,
        // A nested run must not inherit this process's session identity.
        CLAUDE_CODE_ENTRYPOINT: "example-custom-agent",
      },
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

    if (timedOut) {
      throw new Error(`claude timed out after ${TIMEOUT_MS / 1000}s`);
    }
    if (exitCode !== 0) {
      throw new Error(`claude exited with ${exitCode}: ${truncate(stderr.trim(), 500)}`);
    }

    let result: ClaudeResult;
    try {
      result = JSON.parse(stdout.trim()) as ClaudeResult;
    } catch {
      // Fall back to whatever it printed rather than dropping a usable answer on a shape change.
      const text = stdout.trim();
      if (text === "") {
        throw new Error(`claude produced no output: ${truncate(stderr.trim(), 300)}`);
      }
      return text;
    }

    if (result.session_id) {
      await this.sessions.put(discussionID, result.session_id);
    }
    if (result.is_error) {
      throw new Error(`claude reported an error: ${truncate(result.result ?? "", 500)}`);
    }
    if (!result.result?.trim()) {
      throw new Error("claude returned an empty answer");
    }
    return result.result;
  }

  /** Resolved up front so a missing CLI is a startup error, not a failed discussion. */
  static check(): void {
    if (!Bun.which("claude")) throw new Error('"claude" is not on PATH');
  }
}
