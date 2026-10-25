import type { Deps } from "../engine.js";
import { onAllowlist } from "../policy.js";

/** USD price per whole token from live Uniswap quotes (USDG = 1). */
export async function tokenPriceHandler(deps: Deps, args: { tokens: string[] }) {
  const prices = await deps.zhook.prices([...new Set(args.tokens)]);
  return {
    note: "Best executable rate for one whole token on Uniswap v3/v4, direct to USDG or via ETH. USDG = 1 USD.",
    prices,
  };
}

/** Robinhood Stock Tokens verified by exact proxy codehash, with whether the policy lets the agent trade each. */
export async function stockTokensHandler(deps: Deps) {
  const list = await deps.zhook.stockTokens();
  const p = deps.policy;
  return {
    ...list,
    count: list.tokens.length,
    tokens: list.tokens.map((t) => ({
      ...t,
      tradableUnderPolicy: p.allowVerifiedStockTokens || onAllowlist(p, t.address),
    })),
  };
}
