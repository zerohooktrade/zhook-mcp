import type { Deps } from "../engine.js";

/** The active spending policy and what is left of the daily cap. */
export async function spendingPolicyHandler(deps: Deps) {
  const spent = deps.ledger.spentToday();
  return {
    policy: deps.policy,
    source: deps.policySource ?? "default",
    spentTodayUsd: spent,
    remainingTodayUsd: Math.max(0, deps.policy.dailyUsd - spent),
    tradesInWindow: deps.ledger.recent().length,
    window: "rolling 24 h",
  };
}
