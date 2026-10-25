import type { Deps } from "../engine.js";

export interface SimulateArgs {
  from: string;
  to: string;
  data: string;
  value?: string | undefined;
  fundEth?: boolean | undefined;
}

/** eth_call + eth_estimateGas of a transaction from a wallet. Read-only. */
export async function simulateHandler(deps: Deps, args: SimulateArgs) {
  const value = BigInt(args.value ?? "0");
  const r = await deps.zhook.simulate({
    from: args.from as `0x${string}`,
    to: args.to as `0x${string}`,
    data: args.data as `0x${string}`,
    value,
    ...(args.fundEth ? { fundEth: true } : {}),
  });
  return { ...r, from: args.from, to: args.to, value: value.toString() };
}
