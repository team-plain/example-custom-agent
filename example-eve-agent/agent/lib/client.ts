import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Plain } from "#lib/plain.ts";

/**
 * One Plain client, shared by the channel and by every tool.
 *
 * Lazy rather than module-scope, so importing a tool file does not require the key: eve loads
 * every tool at build time, when no .env is in play.
 */
let client: Plain | undefined;

export function plain(): Plain {
  if (client === undefined) {
    const env = dotEnvFirst();
    const apiKey = (env.PLAIN_API_KEY ?? "").trim();
    if (apiKey === "") throw new Error("set PLAIN_API_KEY in .env");
    client = new Plain(apiKey, (env.PLAIN_API_URL ?? "").trim() || undefined);
  }
  return client;
}

/**
 * This package's own .env, over the top of the inherited environment.
 *
 * An exported PLAIN_API_KEY left in a shell otherwise wins and runs the agent as a different
 * machine user against a different workspace, which looks like a broken knowledge base rather
 * than the wrong credential. There is no file in a deployed build, so the platform env stands.
 */
function dotEnvFirst(): Record<string, string | undefined> {
  const merged: Record<string, string | undefined> = { ...process.env };
  // From the working directory, not from import.meta.url: eve bundles this file into .output, so a
  // module-relative path resolves inside the build and silently finds nothing.
  const path = join(process.cwd(), ".env");
  if (!existsSync(path)) return merged;

  for (const rawLine of readFileSync(path, "utf8").split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;

    const separator = line.indexOf("=");
    if (separator === -1) continue;

    const key = line.slice(0, separator).trim();
    const value = line
      .slice(separator + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
    if (key !== "" && value !== "") merged[key] = value;
  }
  return merged;
}

/**
 * Thread ids this process has actually been handed by a webhook.
 *
 * The thread id reaches a tool through the prompt, because an eve tool gets no channel context.
 * That means the model types it back, and a model can invent one, so a tool checks it here before
 * reading a stranger's conversation or replying on it.
 */
const known = new Set<string>();
const KNOWN_LIMIT = 1000;

export function rememberThread(threadID: string): void {
  if (known.size >= KNOWN_LIMIT) known.clear();
  known.add(threadID);
}

export function isKnownThread(threadID: string): boolean {
  return known.has(threadID);
}

// Test seam. The set is module state and a test that populated it would leak into the next one.
export function forgetThreads(): void {
  known.clear();
}
