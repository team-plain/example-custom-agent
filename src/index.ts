import { loadConfig, loadDotEnv } from "./config.ts";
import { runCheck } from "./check.ts";
import { PlainClient } from "./plain.ts";
import { runServe } from "./serve.ts";

const [command = "serve"] = Bun.argv.slice(2);

await loadDotEnv();
const config = loadConfig();
const client = new PlainClient(config.apiKey);

try {
  if (command === "check") {
    await runCheck(client);
  } else if (command === "serve") {
    await runServe(client, config);
  } else {
    throw new Error(`unknown command "${command}": use check or serve`);
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
