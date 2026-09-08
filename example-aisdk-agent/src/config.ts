import { join } from "node:path";

const PROD_API_URL = "https://core-api.uk.plain.com/graphql/v1";

export const WEBHOOK_PATH = "/plain/webhook";
export const PORT = 8082;

/**
 * The events this agent answers. Subscribe your webhook target to both.
 *
 * The approval event is listed because Plain sends it, not because this package acts on it: the
 * turn is held open in memory and polls instead. `example-eve-agent` handles it as an event.
 */
export const AGENT_EVENTS = [
  "discussion.message_created",
  "discussion.tool_call_approval_resolved",
] as const;

export type Config = {
  apiKey: string;
  secret: string;
  /** Prod unless PLAIN_API_URL says otherwise. Read after .env loads, not at import time. */
  apiURL: string;
};

/**
 * Reads .env over the top of the real environment, anchored to this package rather than the
 * working directory: Bun lets the shell win, which is the wrong way round when a stale exported
 * key silently runs the agent as a different machine user.
 */
export async function loadDotEnv(): Promise<void> {
  const file = Bun.file(join(import.meta.dir, "..", ".env"));
  if (!(await file.exists())) return;

  for (const rawLine of (await file.text()).split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;

    const separator = line.indexOf("=");
    if (separator === -1) continue;

    const key = line.slice(0, separator).trim();
    const value = line
      .slice(separator + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
    if (key !== "" && value !== "") process.env[key] = value;
  }
}

export function loadConfig(): Config {
  const apiKey = (process.env.PLAIN_API_KEY ?? "").trim();
  if (apiKey === "") throw new Error("set PLAIN_API_KEY in .env");

  const secret = (process.env.PLAIN_WEBHOOK_SECRET ?? "").trim();
  if (secret === "") {
    throw new Error("set PLAIN_WEBHOOK_SECRET in .env (Plain → Settings → Request Signing)");
  }

  return {
    apiKey,
    secret,
    apiURL: (process.env.PLAIN_API_URL ?? "").trim() || PROD_API_URL,
  };
}

export function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}…`;
}
