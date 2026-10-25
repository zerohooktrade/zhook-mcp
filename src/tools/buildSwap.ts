import { NATIVE, RHC } from "@zerohooktrade/sdk";
import type { Deps } from "../engine.js";
import { evaluate, onAllowlist, refusals } from "../policy.js";
import { PolicyRefusal } from "./errors.js";
import { sizeUsd, stockStatus, summarize } from "./shared.js";

export interface BuildSwapArgs {
  tokenIn: string;
  tokenOut: string;
  amount: string;
  /** The agent's wallet: the calldata is simulated from it and it must sign. */
  from: string;
  slippageBps?: number | undefined;
}

const isEth = (a: string) => a.toUpperCase() === "ETH" || a.toLowerCase() === NATIVE;

/**
 * Policy-checked Universal Router calldata. Every rule of the spending policy runs before calldata is returned; the
 * USD size is added to the rolling 24 h spend when calldata is returned. ERC-20 input without the Permit2 allowances
 * returns the approval calldata first (no spend is recorded for that step).
 */
export async function buildSwapHandler(deps: Deps, args: BuildSwapArgs) {
  const p = deps.policy;
  // Cheap refusals first: no RPC call for a token the policy never allows.
  if (!p.allowVerifiedStockTokens)
    for (const t of [args.tokenIn, args.tokenOut])
      if (!onAllowlist(p, t))
        throw new PolicyRefusal(`${t} is not on the allowlist of policy "${p.name}"`, [
          { rule: "Allowlist", ok: false, detail: `${t} is not on the allowlist` },
        ]);
  const slippageBps = args.slippageBps ?? p.maxSlippageBps;
  if (slippageBps > p.maxSlippageBps)
    throw new PolicyRefusal(`Slippage ${slippageBps} bps is above the policy's ${p.maxSlippageBps} bps`, [
      { rule: "Slippage", ok: false, detail: `${slippageBps / 100}% (max ${p.maxSlippageBps / 100}%)` },
    ]);

  const q = await deps.zhook.quote({
    tokenIn: args.tokenIn,
    tokenOut: args.tokenOut,
    amount: args.amount,
    slippageBps,
    hooks: p.hooks,
    from: args.from,
    pinnedHooksOnly: p.pinnedHooksOnly,
    ...(p.feeBps > 0 && p.feeRecipient ? { feeBps: p.feeBps, feeRecipient: p.feeRecipient } : {}),
  });
  const [size, stock] = await Promise.all([
    sizeUsd(deps, q.tokenIn.address, args.amount),
    stockStatus(deps, q.tokenIn.address, q.tokenOut.address),
  ]);
  const spent = deps.ledger.spentToday();

  // ERC-20 input: the swap cannot simulate until Permit2 allowances exist, so hand those out first.
  if (!isEth(q.tokenIn.address)) {
    const pre = evaluate(p, {
      quote: q,
      sizeUsd: size,
      spentTodayUsd: spent,
      simulated: false,
      ...(stock ? { stock } : {}),
    });
    const preRefusals = refusals(pre).filter((r) => r.rule !== "Calldata");
    if (preRefusals.length) throw new PolicyRefusal(`Refused by policy "${p.name}"`, pre);
    const status = await deps.zhook.approvalStatus(
      args.from as `0x${string}`,
      q.tokenIn.address,
      BigInt(q.amountInRaw),
    );
    if (status.missing.includes("balance"))
      throw new PolicyRefusal(
        `${args.from} holds ${status.balance} raw units of ${q.tokenIn.symbol}, less than ${q.amountInRaw}`,
        [{ rule: "Balance", ok: false, detail: `${status.balance} < ${q.amountInRaw}` }],
      );
    if (status.missing.length) {
      const txs = deps.zhook.approvalTxs(q.tokenIn.address, { amount: BigInt(q.amountInRaw) });
      const needed = txs.filter((_, i) =>
        status.missing.includes(i === 0 ? "erc20-approve-permit2" : "permit2-approve-router"),
      );
      return {
        status: "needs_approval",
        chainId: RHC.id,
        approvals: needed,
        missing: status.missing,
        quote: summarize(q),
        next: "Sign and send these approvals from the agent wallet, then call build_swap again. Nothing was added to the daily spend.",
      };
    }
  }

  const rules = evaluate(p, {
    quote: q,
    sizeUsd: size,
    spentTodayUsd: spent,
    simulated: true,
    ...(stock ? { stock } : {}),
  });
  if (refusals(rules).length) throw new PolicyRefusal(`Refused by policy "${p.name}"`, rules);
  if (!q.tx) throw new PolicyRefusal(q.txNote ?? "No calldata", rules);

  deps.ledger.record({ usd: size!, tokenIn: q.tokenIn.address, tokenOut: q.tokenOut.address, amount: args.amount });
  return {
    status: "ready",
    chainId: RHC.id,
    tx: { to: q.tx.to, data: q.tx.data, value: q.tx.value, from: args.from },
    deadline: q.tx.deadline,
    commands: q.tx.commands,
    minOut: q.minOut,
    gasEstimate: q.gasEstimate,
    sizeUsd: size,
    spentTodayUsd: spent + size!,
    dailyCapUsd: p.dailyUsd,
    rules,
    quote: summarize(q),
    next: "Sign and send tx from the agent wallet before the deadline. The router reverts if fewer than minOut tokens arrive.",
  };
}
