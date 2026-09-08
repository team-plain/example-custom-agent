import { truncate } from "./config.ts";

export const PROVIDER_NAMES = ["claude", "codex", "pi", "opencode"] as const;

export type ProviderName = (typeof PROVIDER_NAMES)[number];

export type Provider = {
  /** The binary that has to be on PATH. */
  bin: string;
  /**
   * True when the CLI takes a session id we invent. Those providers need nothing parsed back out,
   * so a turn can never lose the thread of a discussion by failing to find an id in the output.
   */
  ownsSessionID: boolean;
  args(prompt: string, sessionID: string, resuming: boolean): string[];
  /** Pulls the answer, and the id to resume with, out of whatever the CLI printed. */
  parse(stdout: string): { text: string; sessionID?: string };
};

function jsonLines(stdout: string): Record<string, any>[] {
  const events: Record<string, any>[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      events.push(JSON.parse(trimmed) as Record<string, any>);
    } catch {
      // A partial or non-JSON line is noise, not a failure: the answer is in a later event.
    }
  }
  return events;
}

function textBlocks(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("")
    .trim();
}

const claude: Provider = {
  bin: "claude",
  ownsSessionID: true,
  args: (prompt, sessionID, resuming) => [
    "-p",
    "--output-format",
    "json",
    ...(resuming ? ["--resume", sessionID] : ["--session-id", sessionID]),
    // Auto mode lets Claude approve its own tool calls, which is the only way a headless turn gets
    // to use tools at all: with the default mode every prompt is a denial nobody is there to answer.
    "--permission-mode",
    "auto",
    "--add-dir",
    "/",
    "--settings",
    JSON.stringify({ sandbox: { enabled: false } }),
    prompt,
  ],
  parse(stdout) {
    type Result = { result?: string; session_id?: string; is_error?: boolean };
    let result: Result;
    try {
      result = JSON.parse(stdout.trim()) as Result;
    } catch {
      // Quoting what it actually printed: a non-JSON stdout is usually a startup message or a
      // crash, and the text is the only clue to which.
      throw new Error(`claude did not print json: ${truncate(stdout.trim(), 300)}`);
    }
    if (result.is_error) {
      throw new Error(`claude reported an error: ${truncate(result.result ?? "", 500)}`);
    }
    return { text: (result.result ?? "").trim(), sessionID: result.session_id };
  },
};

const codex: Provider = {
  bin: "codex",
  // Codex mints its own thread id, so the first turn has to read it back out of the event stream.
  ownsSessionID: false,
  args: (prompt, sessionID, resuming) => [
    "exec",
    ...(resuming ? ["resume", sessionID] : []),
    "--json",
    "--skip-git-repo-check",
    "--dangerously-bypass-approvals-and-sandbox",
    prompt,
  ],
  parse(stdout) {
    const events = jsonLines(stdout);
    const messages = events.filter(
      (e) => e.type === "item.completed" && e.item?.type === "agent_message",
    );
    const started = events.find((e) => e.type === "thread.started");
    const last = messages.at(-1);
    return {
      text: typeof last?.item?.text === "string" ? last.item.text.trim() : "",
      sessionID: started?.thread_id as string | undefined,
    };
  },
};

const pi: Provider = {
  bin: "pi",
  ownsSessionID: true,
  // --session-id creates the session when it does not exist yet, so resuming needs no other flag.
  args: (prompt, sessionID) => ["-p", "--mode", "json", "--session-id", sessionID, prompt],
  parse(stdout) {
    const events = jsonLines(stdout);
    const replies = events.filter(
      (e) => (e.type === "turn_end" || e.type === "message_end") && e.message?.role === "assistant",
    );
    return { text: textBlocks(replies.at(-1)?.message?.content) };
  },
};

const opencode: Provider = {
  bin: "opencode",
  ownsSessionID: false,
  args: (prompt, sessionID, resuming) => [
    "run",
    "--format",
    "json",
    ...(resuming ? ["--session", sessionID] : []),
    prompt,
  ],
  parse(stdout) {
    const events = jsonLines(stdout);
    const failure = events.find((e) => e.type === "error");
    if (failure) {
      throw new Error(
        `opencode reported an error: ${truncate(JSON.stringify(failure.error ?? failure), 300)}`,
      );
    }
    // Its event stream is not versioned, so take the last text part anywhere in it rather than
    // pinning to one event name.
    const texts: string[] = [];
    let sessionID: string | undefined;
    for (const event of events) {
      if (typeof event.sessionID === "string") sessionID = event.sessionID;
      const part = event.part ?? event.properties?.part;
      if (part?.type === "text" && typeof part.text === "string" && part.text.trim() !== "") {
        texts.push(part.text.trim());
      }
    }
    return { text: texts.at(-1) ?? "", sessionID };
  },
};

export const PROVIDERS: Record<ProviderName, Provider> = { claude, codex, pi, opencode };
