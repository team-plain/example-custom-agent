import { loadConfig, loadDotEnv } from "./config.ts";
import { runCheck } from "./check.ts";
import { PlainClient } from "./plain.ts";
import { PROVIDER_NAMES, type ProviderName } from "./providers.ts";
import { runServe } from "./serve.ts";
import { fail } from "./ui.ts";

const argv = Bun.argv.slice(2);
const [command = "serve"] = argv.filter((arg) => !arg.startsWith("-"));

/** --provider claude|codex|pi|opencode, or --provider=…. Defaults to Claude Code. */
function readProvider(): ProviderName {
  const flag = argv.findIndex((arg) => arg === "--provider" || arg.startsWith("--provider="));
  if (flag === -1) return "claude";

  const value = argv[flag]!.includes("=") ? argv[flag]!.split("=")[1] : argv[flag + 1];
  if (!value || !PROVIDER_NAMES.includes(value as ProviderName)) {
    throw new Error(`--provider must be one of ${PROVIDER_NAMES.join(", ")}`);
  }
  return value as ProviderName;
}

try {
  await loadDotEnv();
  const config = loadConfig();
  const client = new PlainClient(config.apiKey);

  if (command === "check") {
    await runCheck(client);
  } else if (command === "serve") {
    await runServe(client, config, readProvider());
  } else {
    throw new Error(`unknown command "${command}": use check or serve`);
  }
} catch (err) {
  console.error(fail(err instanceof Error ? err.message : String(err)));
  process.exit(1);
}
