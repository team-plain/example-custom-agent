export const RUNTIME_NAMES = ["local", "vercel-sandbox"] as const;

export type RuntimeName = (typeof RUNTIME_NAMES)[number];

export const DEFAULT_RUNTIME: RuntimeName = "local";

export function isRuntimeName(value: string): value is RuntimeName {
  return (RUNTIME_NAMES as readonly string[]).includes(value);
}

// Unset means local, so an .env written before this option existed still behaves the same. A
// typo is refused rather than defaulted: silently running the CLI on the host is the one
// mistake this switch exists to prevent.
export function readRuntime(env: Record<string, string | undefined> = process.env): RuntimeName {
  const value = (env.AGENT_RUNTIME ?? "").trim();
  if (value === "") return DEFAULT_RUNTIME;
  if (!isRuntimeName(value)) {
    throw new Error(`AGENT_RUNTIME must be one of ${RUNTIME_NAMES.join(", ")}, not "${value}"`);
  }
  return value;
}
