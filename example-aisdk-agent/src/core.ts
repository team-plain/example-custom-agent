import { openai } from "@ai-sdk/openai";
import { generateText, stepCountIs, type ModelMessage, type ToolSet } from "ai";

/**
 * generateText, not streamText.
 *
 * Nothing here consumes a stream: both surfaces post one finished message to Plain, so streaming
 * would only add a buffer to collect it back into a string.
 */
// A cheap, non-reasoning default, so running the example is not a budget decision.
export const DEFAULT_MODEL = "gpt-4o-mini";

// Enough for read, think, act, explain. A runaway loop costs money and posts nothing useful, so
// the ceiling is low and deliberate rather than generous.
const MAX_STEPS = 8;

export type Turn = {
  /** What to post back to Plain. Empty when the model only called tools and said nothing. */
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
 * The one model-calling path both surfaces share.
 *
 * It knows nothing about Plain. Each surface passes its own tools, already wrapped in its own
 * human gate, because the gate mechanisms differ and cannot live here.
 */
export async function runTurn({ system, messages, tools }: TurnRequest): Promise<Turn> {
  const result = await generateText({
    model: openai(modelName()),
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
  if ((env.OPENAI_API_KEY ?? "").trim() !== "") return;
  throw new Error("set OPENAI_API_KEY in .env (this package calls the model directly)");
}
