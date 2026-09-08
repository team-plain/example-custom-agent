import { anthropic } from "@ai-sdk/anthropic";
import { generateText, stepCountIs, type ToolSet } from "ai";

/**
 * generateText, not streamText.
 *
 * Nothing here consumes a stream: both surfaces post one finished message to Plain, so streaming
 * would only add a buffer to collect it back into a string.
 */
export const DEFAULT_MODEL = "claude-sonnet-5";

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
  prompt: string;
  tools: ToolSet;
};

/**
 * The one model-calling path both surfaces share.
 *
 * It knows nothing about Plain. Each surface passes its own tools, already wrapped in whatever
 * human gate that surface has, which is the only honest way to share this: the gate mechanisms
 * differ, so they cannot live here.
 */
export async function runTurn({ system, prompt, tools }: TurnRequest): Promise<Turn> {
  const result = await generateText({
    model: anthropic(modelName()),
    system,
    prompt,
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
  const set = (name: string) => (env[name] ?? "").trim() !== "";
  if (set("ANTHROPIC_API_KEY") || set("ANTHROPIC_AUTH_TOKEN")) return;
  throw new Error("set ANTHROPIC_API_KEY in .env (this package calls the model directly)");
}
