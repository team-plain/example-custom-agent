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
 * Threads this process is allowed to read or reply on.
 *
 * A thread id reaches a tool through the prompt, because an eve tool gets no channel context, so
 * the model types it back and a model can invent one. An id lands here two ways only: a webhook
 * delivered it, or one of the queue tools returned it. Anything else is refused.
 *
 * Process-wide rather than per turn, which is weaker than it could be. `example-aisdk-agent`
 * builds its tools per turn and scopes the same set to that turn. eve trades that for tools that
 * are independent files, and this is the cost.
 */
const reachable = new Set<string>();
const REACHABLE_LIMIT = 1000;

export function rememberThread(threadID: string): void {
  if (reachable.size >= REACHABLE_LIMIT) reachable.clear();
  reachable.add(threadID);
}

export function isKnownThread(threadID: string): boolean {
  return reachable.has(threadID);
}

// Test seam. The set is module state and a test that populated it would leak into the next one.
export function forgetThreads(): void {
  reachable.clear();
}

/** What a tool returns when the model names a thread nothing has handed it. */
export function refuseThread(threadID: string): { ok: false; reason: string } {
  return {
    ok: false,
    reason:
      `${threadID} is not a thread this agent has been given. Call list_thread_queue or ` +
      "search_threads first, then use an id from those results exactly as written.",
  };
}

/**
 * Thread ids the colleague named in the message that started this turn.
 *
 * Recorded by the channel, because the tool that needs it cannot see the prompt. Cleared and
 * rewritten per delivery, so it always describes the request in hand.
 */
let requested = new Set<string>();

export function rememberRequestedThreads(text: string): void {
  requested = threadIDsIn(text);
}

/** Plain ids are prefixed and fixed-length, so this is exact rather than a guess. */
export function threadIDsIn(text: string): Set<string> {
  return new Set(text.match(/\bth_[0-9A-Za-z]{20,32}\b/g) ?? []);
}

/**
 * Whether a reply may target this thread.
 *
 * Two independent conditions. It has to be reachable, meaning a webhook or a search produced it.
 * And if the colleague named any thread in the request, it has to be one of those.
 *
 * The second half is not a nicety. Told to reply to an id it could not use, the model listed the
 * queue and replied to an unrelated customer instead, and no wording in the instructions reliably
 * stopped it. Being handed a bad id is not permission to pick a different customer.
 */
export function mayReplyTo(threadID: string): { ok: true } | { ok: false; reason: string } {
  if (requested.size > 0 && !requested.has(threadID)) {
    return {
      ok: false,
      reason:
        `You were asked about ${[...requested].join(", ")}, so ${threadID} is not the thread to ` +
        "reply on. Tell your colleague the id you were given cannot be used and stop. Do not " +
        "reply to a different customer.",
    };
  }
  if (!isKnownThread(threadID)) return refuseThread(threadID);
  return { ok: true };
}

// Test seam, same reason as forgetThreads.
export function forgetRequestedThreads(): void {
  requested = new Set<string>();
}
