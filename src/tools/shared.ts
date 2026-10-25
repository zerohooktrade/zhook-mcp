import { NATIVE, type QuoteResponse, type Hop } from "@zhooktrade/sdk";
import type { Deps } from "../engine.js";
import { onAllowlist } from "../policy.js";

const fee = (f: number) => (f === 0x800000 ? "dynamic fee" : `${+(f / 10_000).toFixed(4)}%`);

export function hopLabel(h: Hop): string {
  if (h.venue === "v3") return `Uniswap v3 ${fee(h.fee)} ${h.tokenIn} → ${h.tokenOut}`;
  const hook = h.key.hooks.toLowerCase() === NATIVE ? "" : ` hook ${h.key.hooks}`;
  return `Uniswap v4 ${fee(h.key.fee)}${hook} pool ${h.poolId}`;
}

/** A compact, calldata-free view of a quote for an agent to read. */
export function summarize(q: QuoteResponse) {
  return {
    chainId: q.chainId,
    block: q.block,
    tokenIn: q.tokenIn,
    tokenOut: q.tokenOut,
    amountIn: q.amountIn,
    amountOut: q.amountOut,
    amountOutAfterFee: q.amountOutAfterFee,
    minOut: q.minOut,
    slippageBps: q.slippageBps,
    feeBps: q.feeBps,
    priceImpactPct: q.priceImpactPct,
    kind: q.kind,
    route: q.legs.map((l) => ({ shareBps: l.shareBps, hops: l.hops.map(hopLabel) })),
    bestUnhookedOut: q.bestUnhookedOut,
    pinsOk: q.pinsOk,
    hooks: q.hooks,
    warnings: q.warnings,
    blocked: q.blocked,
    candidates: q.candidates.slice(0, 8),
  };
}

/** USD size of the trade input: amount × live price of tokenIn (null when unpriced). */
export async function sizeUsd(deps: Deps, tokenIn: string, amount: string): Promise<number | null> {
  try {
    const p = await deps.zhook.price(tokenIn);
    return p.priceUsd === null ? null : Number(amount) * p.priceUsd;
  } catch {
    return null;
  }
}

/** Verified Stock Token status, only looked up when the policy allows them and the token is not listed. */
export async function stockStatus(deps: Deps, tokenIn: string, tokenOut: string) {
  if (!deps.policy.allowVerifiedStockTokens) return undefined;
  const check = (t: string) => (onAllowlist(deps.policy, t) ? Promise.resolve(false) : deps.zhook.isStockToken(t));
  const [a, b] = await Promise.all([check(tokenIn), check(tokenOut)]);
  return { in: a, out: b };
}
