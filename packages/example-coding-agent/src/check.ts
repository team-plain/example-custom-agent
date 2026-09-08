import type { PlainClient } from "./plain.ts";
import type { RuntimeName } from "./runtime.ts";
import { bold, cyan, dim, fail, heading, label, note, ok, opt, red, warn } from "./ui.ts";

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

// Required to reach Vercel at all, so a missing one is a hard failure rather than a warning.
const SANDBOX_REQUIRED = ["VERCEL_BEARER_TOKEN", "VERCEL_SANDBOX_TEAM_ID", "VERCEL_SANDBOX_PROJECT_ID"];

const SANDBOX_OPTIONAL: Record<string, string> = {
  VERCEL_SANDBOX_SNAPSHOT_ID: "each new sandbox installs the CLI at first start, which is slower",
};

/** Prints who the API key is, whether it can answer, and where the workspace's webhooks point. */
export async function runCheck(client: PlainClient, runtime: RuntimeName): Promise<void> {
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

  reportRuntime(runtime);

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

function reportRuntime(runtime: RuntimeName): void {
  console.log(`\n${heading("runtime")}`);
  console.log(`  ${label("AGENT_RUNTIME")}${bold(runtime)}`);
  if (runtime === "local") {
    console.log(warn("the CLI runs on this machine, with this machine's filesystem in reach"));
    return;
  }

  console.log(dim("  the CLI runs in a Vercel Sandbox, one per discussion"));
  for (const name of SANDBOX_REQUIRED) {
    const set = (process.env[name] ?? "").trim() !== "";
    console.log(set ? ok(name) : fail(`${name} is missing, so no sandbox can be created`));
  }
  for (const [name, consequence] of Object.entries(SANDBOX_OPTIONAL)) {
    if ((process.env[name] ?? "").trim() === "") console.log(opt(`${name} is unset, so ${consequence}`));
  }

  const authenticated = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"].some(
    (name) => (process.env[name] ?? "").trim() !== "",
  );
  if (!authenticated) {
    console.log(fail("no ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN, and a sandbox has no login"));
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
