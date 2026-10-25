import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ZhookError } from "@zerohooktrade/sdk";
import type { RuleResult } from "../policy.js";

/** A trade the spending policy refuses. Carries every rule so the agent can see why. */
export class PolicyRefusal extends Error {
  constructor(
    message: string,
    public readonly rules: RuleResult[],
  ) {
    super(message);
    this.name = "PolicyRefusal";
  }
}

/** JSON with bigints as decimal strings. */
export function toJson(value: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v))) as Record<
    string,
    unknown
  >;
}

export function ok(result: object): CallToolResult {
  const json = toJson(result);
  return { content: [{ type: "text", text: JSON.stringify(json, null, 2) }], structuredContent: json };
}

export function fail(error: unknown): CallToolResult {
  let body: Record<string, unknown>;
  if (error instanceof PolicyRefusal)
    body = { error: error.message, refusedBy: error.rules.filter((r) => r.ok === false), rules: error.rules };
  else if (error instanceof ZhookError) body = { error: error.message, status: error.status };
  else body = { error: error instanceof Error ? error.message.split("\n")[0] : String(error) };
  return { isError: true, content: [{ type: "text", text: JSON.stringify(body, null, 2) }] };
}

/** Run a handler and turn any error into an `isError` result instead of a protocol error. */
export async function run(fn: () => Promise<object>): Promise<CallToolResult> {
  try {
    return ok(await fn());
  } catch (e) {
    return fail(e);
  }
}
