/**
 * Prod unless PLAIN_API_URL says otherwise. The override exists so the approval flow can be driven
 * against dev-uk without editing the source; leave it unset and this example talks to production.
 */
export const API_URL = (process.env.PLAIN_API_URL ?? "").trim() || "https://core-api.uk.plain.com/graphql/v1";

export const DISCUSSION_MESSAGE_CREATED_EVENT = "discussion.message_created";

export const WEBHOOK_PATH = "/plain/webhook";

export const PORT = 8081;

export type Config = {
  apiKey: string;
  secret: string;
  publicURL: string;
  /** Opt in to the agent resolving its own discussion once it has answered. Off unless asked for. */
  resolveWhenDone: boolean;
  /**
   * Which of the agent's own writes need a human to approve them first. The reply is gated by
   * default because it is what the customer sees; the resolve is gated only when the agent resolves
   * at all. The failure report is never gated: gating it strands a broken discussion in silence.
   */
  gated: { reply: boolean; resolve: boolean };
};

/**
 * Reads .env over the top of the real environment. Bun loads .env on its own but lets the shell win,
 * which is the wrong way round here: a stale exported PLAIN_API_KEY silently runs the agent as a
 * different machine user, and the only symptom is answers appearing under the wrong name.
 */
export async function loadDotEnv(): Promise<void> {
  const file = Bun.file(".env");
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

export function loadConfig(): Config {
  const apiKey = (process.env.PLAIN_API_KEY ?? "").trim();
  if (apiKey === "") throw new Error("set PLAIN_API_KEY in .env");

  const secret = (process.env.PLAIN_WEBHOOK_SECRET ?? "").trim();
  if (secret === "") {
    throw new Error("set PLAIN_WEBHOOK_SECRET in .env (Plain → Settings → Request Signing)");
  }

  const resolveWhenDone = (process.env.PLAIN_RESOLVE_WHEN_DONE ?? "").trim() === "1";

  return {
    apiKey,
    secret,
    publicURL: (process.env.PUBLIC_URL ?? "").replace(/\/+$/, ""),
    resolveWhenDone,
    gated: {
      // Opt OUT, not in: an example that ships the gate switched off teaches nothing.
      reply: (process.env.PLAIN_GATE_REPLY ?? "1").trim() !== "0",
      resolve: resolveWhenDone && (process.env.PLAIN_GATE_RESOLVE ?? "1").trim() !== "0",
    },
  };
}

export function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}…`;
}
