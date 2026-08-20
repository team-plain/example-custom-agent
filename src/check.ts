import type { PlainClient } from "./plain.ts";

// The minimum from the README: create posts the answer, read pulls the thread it is about.
const REQUIRED = ["threadDiscussionMessage:create", "threadDiscussion:read"];

// Only needed for the IN_PROGRESS / IDLE status on the discussion, which is cosmetic.
const RECOMMENDED = ["threadDiscussion:edit"];

/** Prints who the API key is, whether it can answer, and where its webhooks point. */
export async function runCheck(client: PlainClient): Promise<void> {
  const me = await client.myMachineUser();
  console.log(`machine user   ${me.id} (${me.fullName})`);
  console.log(`custom agent   ${me.isCustomAgent}`);
  if (!me.isCustomAgent) {
    console.log("\nFAIL  this machine user is not marked as a custom agent, so it will not appear");
    console.log("      in the Ask Sidekick picker. Toggle it on at");
    console.log("      https://app.plain.com/~/settings/machine-users/");
  }

  // Only readable when the key holds apiKey:read, which many keys do not. Not being able to list
  // the permissions says nothing about whether the agent works.
  try {
    const granted = await client.myApiKeyPermissions();
    console.log(`\npermissions    ${granted.length} granted`);
    for (const permission of REQUIRED) {
      console.log(
        granted.includes(permission)
          ? `OK    ${permission}`
          : `FAIL  ${permission} is missing, so the agent cannot answer`,
      );
    }
    for (const permission of RECOMMENDED) {
      if (!granted.includes(permission)) {
        console.log(`warn  ${permission} is missing, so the discussion shows no agent status`);
      }
    }
  } catch {
    console.log("\npermissions    not readable with this key, so check in the dashboard that it");
    console.log(`               grants ${REQUIRED.join(" and ")}`);
  }

  try {
    const targets = await client.webhookTargets();
    console.log(`\n${targets.length} webhook target(s):`);
    for (const target of targets) {
      console.log(`  ${target.url}`);
      console.log(
        `    version=${target.version} enabled=${target.isEnabled} ` +
          `events=${target.eventSubscriptions.map((s) => s.eventType).join(",")}`,
      );
    }
  } catch {
    console.log("\nwebhook targets not readable with this key, so check them in the dashboard");
  }
}
