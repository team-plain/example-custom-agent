import type { PlainClient } from "./plain.ts";
import { bold, cyan, fail, heading, label, note, ok, opt, red, warn } from "./ui.ts";

// The minimum from the README: create posts the answer, read pulls the thread it is about.
const REQUIRED = ["threadDiscussionMessage:create", "threadDiscussion:read"];

// The agent answers without this, it just cannot show that it is working.
const RECOMMENDED: Record<string, string> = {
  "threadDiscussion:edit": "the discussion shows no agent status while the agent works",
};

// Only `check` wants these. Nothing the agent does at runtime touches them.
const OPTIONAL: Record<string, string> = {
  "apiKey:read": "this key's own permissions cannot be listed below",
  "webhookTarget:read": "the workspace's webhook targets cannot be listed below",
};

const MACHINE_USERS_URL = "https://app.plain.com/~/settings/machine-users/";

/** Prints who the API key is, whether it can answer, and where the workspace's webhooks point. */
export async function runCheck(client: PlainClient): Promise<void> {
  const me = await client.myMachineUser();
  console.log(`${label("machine user")}${bold(me.id)} ${me.fullName}`);
  console.log(`${label("custom agent")}${me.isCustomAgent ? "yes" : red("no")}`);
  if (!me.isCustomAgent) {
    console.log(fail("this machine user is not a custom agent, so it stays out of the picker"));
    console.log(`${note("toggle Custom agent on at")} ${cyan(MACHINE_USERS_URL)}`);
  }

  console.log(`\n${heading("permissions")}`);
  try {
    const granted = await client.myApiKeyPermissions();
    for (const permission of REQUIRED) {
      console.log(
        granted.includes(permission)
          ? ok(permission)
          : fail(`${permission} is missing, so the agent cannot answer`),
      );
    }
    report(granted, RECOMMENDED, warn);
    report(granted, OPTIONAL, opt);
  } catch {
    console.log(opt(`apiKey:read is missing, so ${OPTIONAL["apiKey:read"]}`));
    console.log(note(`confirm in the dashboard that it grants ${REQUIRED.join(" and ")}`));
  }

  console.log(`\n${heading("webhook targets")}`);
  try {
    const targets = await client.webhookTargets();
    if (targets.length === 0) console.log(note("none in this workspace yet"));
    for (const target of targets) {
      const events = target.eventSubscriptions.map((s) => s.eventType).join(", ");
      console.log(`  ${cyan(target.url)}`);
      console.log(note(`version ${target.version}  enabled ${target.isEnabled}  ${events}`));
    }
  } catch {
    console.log(opt(`webhookTarget:read is missing, so ${OPTIONAL["webhookTarget:read"]}`));
  }
}

function report(
  granted: string[],
  tier: Record<string, string>,
  line: (msg: string) => string,
): void {
  for (const [permission, consequence] of Object.entries(tier)) {
    if (!granted.includes(permission)) {
      console.log(line(`${permission} is missing, so ${consequence}`));
    }
  }
}
