import { homedir } from "node:os";
import { resolve } from "node:path";

export const DEFAULT_API_URL = "https://core-api.uk.plain.com/graphql/v1";

// The webhook schema version that first carries discussion.message_created. A target pinned to an
// older version is silently never delivered the event, so this is not cosmetic.
export const WEBHOOK_TARGET_VERSION = "2026-08-19";

export const DISCUSSION_MESSAGE_CREATED_EVENT = "discussion.message_created";

export const WEBHOOK_PATH = "/plain/webhook";

export type Config = {
  apiURL: string;
  apiKey: string;
  port: number;
  publicURL: string;
  secret: string;
  claudeBin: string;
  /** Where sessions.json lives. Not a sandbox: Claude runs with the whole filesystem in reach. */
  workdir: string;
  /** The directory Claude Code starts in. Everything outside it is still reachable. */
  claudeCwd: string;
  permissionMode: string;
  timeoutMs: number;
};

/**
 * Reads KEY=VALUE lines from .env and overrides the real environment. .env is the source of truth on
 * purpose: a stale PLAIN_API_KEY exported in a shell silently runs the agent as a different machine
 * user, which is very hard to spot. Bun loads .env on its own but lets the shell win, which is the
 * opposite of what this needs, so the file is parsed here instead.
 */
export async function loadDotEnv(path: string): Promise<void> {
  const file = Bun.file(path);
  if (!(await file.exists())) return;

  for (const rawLine of (await file.text()).split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;

    const separator = line.indexOf("=");
    if (separator === -1) continue;

    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim().replace(/^["']|["']$/g, "");
    if (key !== "" && value !== "") process.env[key] = value;
  }
}

function envOr(key: string, fallback: string): string {
  const value = process.env[key];
  return value === undefined || value === "" ? fallback : value;
}

export function loadConfig(): Config {
  const apiKey = (process.env.PLAIN_API_KEY ?? "").trim();
  if (apiKey === "") throw new Error("set PLAIN_API_KEY in .env");

  return {
    apiURL: envOr("PLAIN_API_URL", DEFAULT_API_URL),
    apiKey,
    port: Number(envOr("PORT", "8081")),
    publicURL: (process.env.PUBLIC_URL ?? "").replace(/\/+$/, ""),
    secret: process.env.PLAIN_WEBHOOK_SECRET ?? "",
    claudeBin: envOr("CLAUDE_BIN", "claude"),
    workdir: resolve(envOr("AGENT_WORKDIR", "./workdir")),
    // Home, not the workdir: the agent is meant to reach the whole machine, and starting inside a
    // scratch folder is what makes a run feel confined even when nothing is enforcing it.
    claudeCwd: resolve(envOr("CLAUDE_CWD", homedir())),
    permissionMode: envOr("CLAUDE_PERMISSION_MODE", "auto"),
    timeoutMs: Number(envOr("CLAUDE_TIMEOUT_SECONDS", "180")) * 1000,
  };
}

export function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}…`;
}
