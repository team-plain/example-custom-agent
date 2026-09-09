import { generateText, stepCountIs, type ModelMessage, type ToolSet } from "ai";

/**
 * generateText, not streamText.
 *
 * Nothing here consumes a stream. The turn posts one finished message to Plain, so streaming would
 * only add a buffer to collect the text back into a string. The progressive part of this agent is
 * the tool calls on the discussion timeline, not the tokens.
 */
// A bare string model id, which the AI SDK routes through the Vercel AI Gateway. That keeps this
// package to one model credential and lets AGENT_MODEL name any model the gateway serves.
export const DEFAULT_MODEL = "anthropic/claude-sonnet-5";

// Enough for read, think, act, explain. A runaway loop costs money and posts nothing useful, so
// the ceiling is low and deliberate rather than generous.
const MAX_STEPS = 8;

export type Turn = {
  /** What to post back to Plain. Empty means the model only called tools and said nothing. */
  text: string;
  /** How many model round trips it took, for the log. */
  steps: number;
};

export type TurnRequest = {
  system: string;
  /**
   * The conversation, oldest first, ending with the message this turn answers.
   *
   * A `messages` array rather than a single `prompt`: with one string the model starts every turn
   * from nothing, so "the thread you just replied to" has no referent and it guesses.
   */
  messages: ModelMessage[];
  tools: ToolSet;
};

/**
 * The one model-calling path.
 *
 * It knows nothing about Plain. The caller passes the tools, already wrapped in the human gate.
 */
export async function runTurn({ system, messages, tools }: TurnRequest): Promise<Turn> {
  const result = await generateText({
    model: modelName(),
    system,
    messages,
    tools,
    // Without a stop condition the SDK takes a single step, so a tool call would be requested and
    // never answered, and the turn would end with no text.
    stopWhen: stepCountIs(MAX_STEPS),
  });

  return { text: result.text.trim(), steps: result.steps.length };
}

export function modelName(): string {
  return (process.env.AGENT_MODEL ?? "").trim() || DEFAULT_MODEL;
}

/** Checked up front so a missing key fails at startup rather than mid-conversation. */
export function assertModelCredential(env: Record<string, string | undefined> = process.env): void {
  if ((env.AI_GATEWAY_API_KEY ?? "").trim() !== "") return;
  if ((env.VERCEL_OIDC_TOKEN ?? "").trim() !== "") return;
  throw new Error(
    "set AI_GATEWAY_API_KEY in .env (this package routes the model through the Vercel AI Gateway)",
  );
}
