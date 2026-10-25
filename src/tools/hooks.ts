import { feeLabel } from "@zerohooktrade/sdk";
import type { Deps } from "../engine.js";

export interface ListHookPoolsArgs {
  hook?: string | undefined;
  token?: string | undefined;
  limit?: number | undefined;
}

/** Hooks in the pool list (most swaps first), or the pools of one hook. */
export async function listHookPoolsHandler(deps: Deps, args: ListHookPoolsArgs) {
  const reg = deps.zhook.registry;
  const limit = args.limit ?? 25;
  const token = args.token?.toLowerCase();
  if (args.hook) {
    const pools = reg
      .forHook(args.hook)
      .filter((p) => !token || p.key.currency0 === token || p.key.currency1 === token)
      .sort((a, b) => b.swaps - a.swaps);
    return {
      hook: args.hook,
      pin: reg.hookPin(args.hook),
      total: pools.length,
      pools: pools.slice(0, limit).map((p) => ({
        poolId: p.id,
        currency0: p.key.currency0,
        currency1: p.key.currency1,
        fee: feeLabel(p.key.fee),
        tickSpacing: p.key.tickSpacing,
        swaps: p.swaps,
        positions: p.positions,
        source: p.source,
      })),
    };
  }
  const hooks = reg.hooks().filter((h) => !token || h.tokens.includes(token as `0x${string}`));
  return {
    poolListSize: reg.size,
    total: hooks.length,
    note: "Swap counts come from the pool list's activity window. Call hook_passport for what a hook can do.",
    hooks: hooks.slice(0, limit).map((h) => ({ ...h, tokens: h.tokens.slice(0, 8) })),
  };
}

/** Hook Passport: permissions, proxy, owner, verification, bytecode scan and risk score. */
export async function hookPassportHandler(deps: Deps, args: { hook: string }) {
  return deps.zhook.hookPassport(args.hook);
}
