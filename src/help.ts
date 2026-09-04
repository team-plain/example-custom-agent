import { PORT, WEBHOOK_PATH } from "./config.ts";
import { PROVIDERS, PROVIDER_NAMES, type ProviderName } from "./providers.ts";
import { bold, cyan, dim, green, heading, red, yellow } from "./ui.ts";

const DEFAULT_PROVIDER: ProviderName = "claude";

const COMMANDS: [string, string][] = [
  ["serve [--provider <name>]", "answer Ask Sidekick discussions (the default command)"],
  ["check", "who the API key is, what it can do, where the workspace's webhooks point"],
  ["help", "this"],
];

const VARIABLES: [string, string][] = [
  ["PLAIN_API_KEY", "required"],
  ["PLAIN_WEBHOOK_SECRET", "required"],
  ["PUBLIC_URL", "optional, only printed on startup so you can paste it into Plain"],
  ["PLAIN_RESOLVE_WHEN_DONE", "optional, set to 1 to resolve the discussion after answering"],
];

/** Runs before the config is validated, so it still works when .env is the thing that is wrong. */
export function runHelp(): void {
  console.log(`${bold("example-custom-agent")} ${dim("a custom agent for Plain, run by an agent CLI")}`);

  console.log(`\n${heading("commands")}`);
  for (const [usage, what] of COMMANDS) {
    console.log(`  ${cyan(usage.padEnd(28))}${dim(what)}`);
  }

  console.log(`\n${heading("providers")}`);
  for (const name of PROVIDER_NAMES) {
    const installed = Bun.which(PROVIDERS[name].bin) !== null;
    console.log(
      `  ${name.padEnd(10)}${installed ? green("installed") : red("not on PATH")}` +
        `${name === DEFAULT_PROVIDER ? dim("   default") : ""}`,
    );
  }
  console.log(dim("  each one needs its own login, and runs with its own permissions"));

  console.log(`\n${heading(".env")}`);
  for (const [name, note] of VARIABLES) {
    const set = (process.env[name] ?? "") !== "";
    console.log(`  ${name.padEnd(22)}${set ? green("set") : yellow("unset")}   ${dim(note)}`);
  }

  console.log(`\n${dim(`webhooks are delivered to :${PORT}${WEBHOOK_PATH}`)}`);
}
