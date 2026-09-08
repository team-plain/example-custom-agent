/**
 * Whether a delivery is this agent's to answer, and nothing else.
 *
 * Split out of the channel so it can be tested without loading eve or the webhooks package. It is
 * the only logic here that decides whether the agent speaks, so it is the part worth a test.
 */

// Narrow structural types naming only the fields these decisions read. The webhooks package ships
// the full ones.
export type PlainMessagePayload = {
  eventType: string;
  discussion: { id: string; type: string; status: string; agent?: { id: string } | null };
  message: { id: string; type: string; text?: string | null; markdown?: string | null };
};

export type PlainApprovalPayload = {
  eventType: string;
  discussion: { id: string };
  toolCall: { toolCallId: string };
  approval: { status: string; reviewerNote?: string | null };
};

/**
 * The four conditions from the docs.
 *
 * The message-type check is the loop guard: the agent's own replies come back as INBOUND, so
 * dropping it makes the agent answer itself forever.
 */
export function shouldAnswer(payload: PlainMessagePayload, myMachineUserID: string): boolean {
  return (
    payload.discussion.type === "AGENT_SESSION" &&
    payload.discussion.agent?.id === myMachineUserID &&
    payload.message.type === "OUTBOUND" &&
    payload.discussion.status !== "RESOLVED"
  );
}

/** The text to send the model, preferring markdown. Empty means there is nothing to answer. */
export function promptFrom(payload: PlainMessagePayload): string {
  return (payload.message.markdown ?? payload.message.text ?? "").trim();
}

/** Plain's approval status as the eve option id that answers the parked request. */
export function optionIDFor(approvalStatus: string): "approve" | "cancel" {
  return approvalStatus === "APPROVED" ? "approve" : "cancel";
}

/**
 * Bounded set of handled delivery ids.
 *
 * In memory, which is enough for an example and not enough for production: a second instance does
 * not see this set and a restart forgets it.
 */
export class SeenDeliveries {
  private readonly seen = new Set<string>();
  private readonly limit: number;

  // A plain field rather than a constructor parameter property: Node's strip-only TypeScript mode
  // cannot transform those, and this package runs its tests with `node --test`.
  constructor(limit = 1000) {
    this.limit = limit;
  }

  /** True when this id has been handled before. Records it either way. */
  check(id: string): boolean {
    if (this.seen.has(id)) return true;
    if (this.seen.size >= this.limit) this.seen.clear();
    this.seen.add(id);
    return false;
  }

  get size(): number {
    return this.seen.size;
  }
}
