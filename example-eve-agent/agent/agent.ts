import { defineAgent } from "eve";

// Sonnet through the AI Gateway. A string model id routes through the gateway, which needs
// AI_GATEWAY_API_KEY or a VERCEL_OIDC_TOKEN. Swap it for a provider model object to skip the
// gateway. Check the exact id against the gateway's model list: a near-miss returns a 404.
export default defineAgent({
  model: "anthropic/claude-sonnet-5",
});
