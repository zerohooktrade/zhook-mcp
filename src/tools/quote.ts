import type { Deps } from "../engine.js";
import { evaluate, refusals } from "../policy.js";
import { sizeUsd, stockStatus, summarize } from "./shared.js";

export interface QuoteArgs {
  tokenIn: string;
  tokenOut: string;
  amount: string;
  slippageBps?: number | undefined;
}

/** Best route and a policy preview. Never returns calldata. */
export async function quoteHandler(deps: Deps, args: QuoteArgs) {
  const p = deps.policy;
  const q = await deps.zhook.quote({
    tokenIn: args.tokenIn,
    tokenOut: args.tokenOut,
    amount: args.amount,
    slippageBps: args.slippageBps ?? p.maxSlippageBps,
    hooks: p.hooks,
    ...(p.feeBps > 0 && p.feeRecipient ? { feeBps: p.feeBps, feeRecipient: p.feeRecipient } : {}),
  });
  const [size, stock] = await Promise.all([
    sizeUsd(deps, q.tokenIn.address, args.amount),
    stockStatus(deps, q.tokenIn.address, q.tokenOut.address),
  ]);
  const rules = evaluate(p, {
    quote: q,
    sizeUsd: size,
    spentTodayUsd: deps.ledger.spentToday(),
    simulated: false,
    ...(stock ? { stock } : {}),
  });
  return {
    quote: summarize(q),
    sizeUsd: size,
    policy: { name: p.name, wouldAllow: refusals(rules).length === 0, rules },
    next: "No calldata is returned here. Call build_swap with the agent wallet to get policy-checked, simulated calldata.",
  };
}
