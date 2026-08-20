import { WEBHOOK_PATH, loadConfig, loadDotEnv, type Config } from "./config.ts";
import { runCheck } from "./check.ts";
import { PlainClient } from "./plain.ts";
import { runServe } from "./serve.ts";
import { runSimulate } from "./simulate.ts";

const WEBHOOK_DESCRIPTION = "Example custom agent";

async function main(): Promise<void> {
  const [command = "serve", argument = ""] = Bun.argv.slice(2);

  await loadDotEnv(process.env.ENV_FILE ?? ".env");
  const config = loadConfig();
  const client = new PlainClient(config.apiURL, config.apiKey);

  switch (command) {
    case "check":
      return runCheck(client);
    case "setup":
      return runSetup(client, config);
    case "serve":
      return runServe(client, config);
    case "simulate":
      return runSimulate(
        client,
        config,
        argument === "" ? "Say hello and tell me which machine you are running on." : argument,
      );
    default:
      throw new Error(`unknown command "${command}": use check, setup, serve or simulate`);
  }
}

/**
 * Points a webhook target at this agent. It repoints the target with the same description rather
 * than adding another, because a stale target keeps firing at a dead ngrok URL.
 */
async function runSetup(client: PlainClient, config: Config): Promise<void> {
  if (config.publicURL === "") {
    throw new Error("set PUBLIC_URL to the https URL that reaches this process (e.g. your ngrok URL)");
  }
  const url = config.publicURL + WEBHOOK_PATH;

  // Matched on the path, not the description: a target renamed at some point is still the same
  // target, and a second one firing at a dead ngrok URL is exactly what this avoids.
  const targets = await client.webhookTargets();
  const existing = targets.find((t) => new URL(t.url).pathname === WEBHOOK_PATH);
  const target = existing
    ? await client.updateWebhookTarget(existing.id, url)
    : await client.createWebhookTarget(url, WEBHOOK_DESCRIPTION);

  console.log(`${existing ? "updated" : "created"} webhook target ${target.id}`);
  console.log(`  url     ${target.url}`);
  console.log(`  version ${target.version}`);
  console.log(`  events  ${target.eventSubscriptions.map((s) => s.eventType).join(", ")}`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
