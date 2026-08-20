import type { PlainClient } from "./plain.ts";

// The one permission the agent cannot run without: it is how the answer gets posted.
const REQUIRED = "threadDiscussionMessage:create";

// Without these the agent still answers, but the discussion never shows an agent status.
// updateDiscussionAgentStatus reads the discussion before editing it, so it needs both.
const RECOMMENDED = ["threadDiscussion:read", "threadDiscussion:edit"];

/** Prints who the API key is, whether it can answer, and where its webhooks point. */
export async function runCheck(client: PlainClient): Promise<void> {
  const me = await client.myMachineUser();
  console.log(`machine user   ${me.id} (${me.fullName})`);
  console.log(`custom agent   ${me.isCustomAgent}`);
  if (!me.isCustomAgent) {
    console.log("\nFAIL  this machine user is not marked as a custom agent, so it will not appear");
    console.log("      in the Ask Sidekick picker. Settings -> Machine users -> Custom agent.");
  }

  // Only readable when the key holds apiKey:read, which many keys do not. Not being able to list
  // the permissions says nothing about whether the agent works.
  try {
    const granted = await client.myApiKeyPermissions();
    console.log(`\npermissions    ${granted.length} granted`);
    if (!granted.includes(REQUIRED)) {
      console.log(`FAIL  ${REQUIRED} is missing, so the agent cannot post an answer`);
    }
    for (const permission of RECOMMENDED) {
      if (!granted.includes(permission)) {
        console.log(`warn  ${permission} is missing, so the discussion shows no agent status`);
      }
    }
    if (granted.includes(REQUIRED) && RECOMMENDED.every((p) => granted.includes(p))) {
      console.log(`OK    ${REQUIRED} and the status permissions are granted`);
    }
  } catch {
    console.log(`\npermissions    not readable with this key, so check in the dashboard that it`);
    console.log(`               grants ${REQUIRED}`);
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
