import { defineAgent } from "eve";

// Haiku through the AI Gateway: cheap enough to run this example repeatedly without thinking about
// it. Swap the string for any model the gateway serves, or a provider model object.
export default defineAgent({
  model: "anthropic/claude-haiku-4.5",
});
