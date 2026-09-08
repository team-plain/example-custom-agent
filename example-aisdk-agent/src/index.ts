import { join } from "node:path";
import { assertModelCredential, modelName } from "./core.ts";
import { INTERNAL_EVENTS, SUPPORT_EVENTS, loadConfig, loadDotEnv } from "./config.ts";
import { Plain } from "./plain.ts";
import { runServe, type Prompts } from "./serve.ts";

const PROMPTS_DIR = join(import.meta.dir, "..", "prompts");

const VARIABLES: [string, string][] = [
  ["PLAIN_API_KEY", "required"],
  ["PLAIN_WEBHOOK_SECRET", "required"],
  ["OPENAI_API_KEY", "required, this package calls the model directly"],
  ["PLAIN_API_URL", "optional, defaults to production"],
  ["AGENT_MODEL", "optional, defaults to gpt-4o-mini"],
  ["PLAIN_SURFACE_SUPPORT", "optional, 0 to switch the customer-thread surface off"],
  ["PLAIN_SURFACE_INTERNAL", "optional, 0 to switch the Sidekick surface off"],
  ["PLAIN_GATE_SUPPORT", "optional, 0 to send replies instead of drafting them"],
  ["PLAIN_GATE_INTERNAL", "optional, 0 to skip the approval card"],
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
    await runServe(plain, config, await prompts());
  } else {
    throw new Error(`unknown command "${command}": run \`bun run help\``);
  }
} catch (err) {
  console.error(`FAIL ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

async function prompts(): Promise<Prompts> {
  const [support, internal] = await Promise.all([
    read(join(PROMPTS_DIR, "support.md")),
    read(join(PROMPTS_DIR, "internal.md")),
  ]);
  return { support, internal };
}

async function read(path: string): Promise<string> {
  const file = Bun.file(path);
  if (!(await file.exists())) throw new Error(`${path} is missing`);
  return (await file.text()).trim();
}

/** Prints who the key is and which events each surface needs, before anything is served. */
async function check(plain: Plain, apiURL: string): Promise<void> {
  console.log(`endpoint     ${apiURL}`);
  console.log(`model        ${modelName()}`);

  const myID = await plain.myMachineUserID();
  console.log(`machine user ${myID}`);

  console.log("\nsupport surface, subscribe a webhook target to:");
  for (const event of SUPPORT_EVENTS) console.log(`  ${event}`);
  console.log("\ninternal surface, subscribe a webhook target to:");
  for (const event of INTERNAL_EVENTS) console.log(`  ${event}`);

  console.log("\nboth need webhook version 2026-09-06, matching @team-plain/webhooks 1.9.0");

  try {
    assertModelCredential();
    console.log("model credential set");
  } catch (err) {
    console.log(`model credential MISSING: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function help(): void {
  console.log("example-aisdk-agent  both Plain agent surfaces on the Vercel AI SDK\n");
  console.log("commands");
  console.log("  serve    answer webhooks for whichever surfaces are switched on (default)");
  console.log("  check    who the key is, which events to subscribe, whether the model is reachable");
  console.log("  help     this\n");
  console.log(".env");
  for (const [name, note] of VARIABLES) console.log(`  ${name.padEnd(26)}${note}`);
}
