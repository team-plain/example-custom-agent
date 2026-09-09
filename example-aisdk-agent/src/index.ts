import { join } from "node:path";
import { assertModelCredential, modelName } from "./core.ts";
import { AGENT_EVENTS, loadConfig, loadDotEnv } from "./config.ts";
import { Plain } from "./plain.ts";
import { runServe } from "./serve.ts";

const PROMPT_PATH = join(import.meta.dir, "..", "prompts", "agent.md");

const VARIABLES: [string, string][] = [
  ["PLAIN_API_KEY", "required"],
  ["PLAIN_WEBHOOK_SECRET", "required"],
  ["AI_GATEWAY_API_KEY", "required, routes the model through the Vercel AI Gateway"],
  ["PLAIN_API_URL", "optional, defaults to production"],
  ["AGENT_MODEL", "optional, defaults to anthropic/claude-sonnet-5"],
];

const command = Bun.argv[2] ?? "serve";

try {
  await loadDotEnv();

  // Before loadConfig on purpose: help has to work when .env is what is wrong.
  if (command === "help" || Bun.argv.includes("--help") || Bun.argv.includes("-h")) {
    help();
    process.exit(0);
  }

  const config = loadConfig();
  const plain = new Plain(config.apiKey, config.apiURL);

  if (command === "check") {
    await check(plain, config.apiURL);
  } else if (command === "serve") {
    assertModelCredential();
    await runServe(plain, config, await readPrompt());
  } else {
    throw new Error(`unknown command "${command}": run \`bun run help\``);
  }
} catch (err) {
  console.error(`FAIL ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

async function readPrompt(): Promise<string> {
  const file = Bun.file(PROMPT_PATH);
  if (!(await file.exists())) throw new Error(`${PROMPT_PATH} is missing`);
  return (await file.text()).trim();
}

/** Everything that has to be right before serving: identity, events, model, knowledge. */
async function check(plain: Plain, apiURL: string): Promise<void> {
  console.log(`endpoint     ${apiURL}`);
  console.log(`model        ${modelName()}`);

  const myID = await plain.myMachineUserID();
  console.log(`machine user ${myID}`);

  console.log("\nsubscribe a webhook target to:");
  for (const event of AGENT_EVENTS) console.log(`  ${event}`);
  console.log("\non webhook version 2026-09-06, matching @team-plain/webhooks 1.9.0");

  // An agent with nothing indexed searches successfully and finds nothing, which reads as a broken
  // agent rather than an empty help center. Worth knowing before the first turn.
  try {
    const hits = await plain.searchKnowledge("how do I get started", 3);
    console.log(`\nknowledge   ${hits.length} result(s) for a sample query`);
    if (hits.length === 0) {
      console.log("            nothing is indexed yet, so the agent has nothing to answer from");
    }
    for (const hit of hits) console.log(`            ${hit.source}`);
  } catch (err) {
    console.log(`\nknowledge   FAILED: ${err instanceof Error ? err.message : String(err)}`);
  }

  try {
    assertModelCredential();
    console.log("\nmodel credential set");
  } catch (err) {
    console.log(`\nmodel credential MISSING: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function help(): void {
  console.log("example-aisdk-agent  a Plain agent on the Vercel AI SDK\n");
  console.log("It answers in a Sidekick discussion: finds the thread, reads it, searches the");
  console.log("workspace knowledge, and proposes a reply for a person to approve. A discussion");
  console.log("opened on no thread still works, because it can search the queue.\n");
  console.log("commands");
  console.log("  serve    answer discussion webhooks (default)");
  console.log("  check    identity, events, model, and whether anything is indexed to search");
  console.log("  help     this\n");
  console.log(".env");
  for (const [name, note] of VARIABLES) console.log(`  ${name.padEnd(26)}${note}`);
}
