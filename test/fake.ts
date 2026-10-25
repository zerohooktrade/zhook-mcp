import {
  approvalTxs,
  NATIVE,
  PoolRegistry,
  RHC,
  type ApprovalStatus,
  type Passport,
  type PriceQuote,
  type QuoteParams,
  type QuoteResponse,
  type Simulation,
  type StockTokenList,
} from "@zerohooktrade/sdk";
import type { Engine } from "../src/engine.js";

export const USDG = RHC.usdg;
export const NVDA = "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC";
export const MEME = "0x1000000000000000000000000000000000000001";
export const AGENT = "0x00000000000000000000000000000000000a6e17";
export const HOOK = "0x00000000000000000000000000000000000000c8";

const meta: Record<string, { symbol: string; decimals: number; usd: number | null }> = {
  [NATIVE]: { symbol: "ETH", decimals: 18, usd: 3000 },
  [USDG.toLowerCase()]: { symbol: "USDG", decimals: 6, usd: 1 },
  [NVDA.toLowerCase()]: { symbol: "NVDA", decimals: 18, usd: 200 },
  [MEME]: { symbol: "MEME", decimals: 18, usd: null },
};
const norm = (t: string) => (t.toUpperCase() === "ETH" ? NATIVE : t.toLowerCase());

export interface FakeOptions {
  impactPct?: number | null;
  pinsOk?: boolean;
  hookStatus?: "match" | "changed" | "new" | null;
  simulationOk?: boolean;
  approvalsMissing?: ApprovalStatus["missing"];
}

/** A stand-in for the SDK router: deterministic quotes, prices and checks, and a record of every call. */
export function fakeEngine(opts: FakeOptions = {}) {
  const calls: { method: string; args: unknown }[] = [];
  const registry = new PoolRegistry({
    includeDefaults: false,
    pools: [
      { key: { currency0: NATIVE, currency1: USDG, fee: 3000, tickSpacing: 60, hooks: HOOK }, swaps: 40 },
      { key: { currency0: NATIVE, currency1: NVDA, fee: 3000, tickSpacing: 60, hooks: HOOK }, swaps: 2 },
    ],
    hookPins: { [HOOK]: ["0x" + "11".repeat(32), 100] },
  });
  const engine: Engine & { calls: typeof calls } = {
    calls,
    registry,
    async quote(p: QuoteParams): Promise<QuoteResponse> {
      calls.push({ method: "quote", args: p });
      const a = meta[norm(p.tokenIn)]!;
      const b = meta[norm(p.tokenOut)]!;
      const out = ((Number(p.amount) * (a.usd ?? 1)) / (b.usd ?? 1)).toFixed(6);
      const hooks =
        opts.hookStatus === null || opts.hookStatus === undefined
          ? []
          : [
              {
                hook: HOOK as `0x${string}`,
                codehash: "0x",
                pinned: "0x",
                status: opts.hookStatus,
                flags: ["beforeSwap"],
                proxy: false,
              },
            ];
      const pinsOk = opts.pinsOk ?? true;
      const sim: Simulation | null = p.from
        ? opts.simulationOk === false
          ? { ok: false, gasEstimate: null, error: "TRANSFER_FROM_FAILED", overridden: false }
          : { ok: true, gasEstimate: "180000", error: null, overridden: false }
        : null;
      return {
        chainId: 4663,
        block: 100,
        tokenIn: {
          address: norm(p.tokenIn) as `0x${string}`,
          symbol: a.symbol,
          decimals: a.decimals,
          ...(norm(p.tokenIn) === NATIVE ? { native: true } : {}),
        },
        tokenOut: { address: norm(p.tokenOut) as `0x${string}`, symbol: b.symbol, decimals: b.decimals },
        amountIn: p.amount,
        amountInRaw: (BigInt(Math.round(Number(p.amount) * 1e6)) * 10n ** BigInt(a.decimals - 6)).toString(),
        amountOut: out,
        amountOutRaw: "1",
        amountOutAfterFee: out,
        minOut: out,
        minOutRaw: "1",
        slippageBps: Number(p.slippageBps ?? 50),
        feeBps: Number(p.feeBps ?? 0),
        feeRecipient: null,
        priceImpactPct: opts.impactPct === undefined ? 0.1 : opts.impactPct,
        kind: "single",
        legs: [
          {
            shareBps: 10_000,
            amountIn: "1",
            amountOut: "1",
            hops: [
              {
                venue: "v3",
                pool: "0x2222222222222222222222222222222222222222",
                tokenIn: RHC.weth,
                tokenOut: USDG,
                fee: 500,
              },
            ],
          },
        ],
        candidates: [{ label: "Uniswap v3 · 0.05%", venue: "v3", hooked: false, amountOut: "1" }],
        hubCandidates: [],
        bestUnhookedOut: out,
        gasEstimate: sim?.gasEstimate ?? null,
        simulation: sim,
        pins: [],
        pinsOk,
        hooks,
        warnings: [],
        blocked: pinsOk ? [] : ["Pinned-contract check failed"],
        tx: pinsOk
          ? {
              to: RHC.universalRouter,
              data: "0xdeadbeef",
              value: "0",
              commands: ["V3_SWAP_EXACT_IN", "SWEEP"],
              deadline: 1_900_000_000,
            }
          : null,
        txNote: pinsOk
          ? sim && !sim.ok
            ? `Simulation from ${p.from} reverted: ${sim.error}`
            : null
          : "Calldata withheld",
        approval:
          norm(p.tokenIn) === NATIVE
            ? null
            : { token: norm(p.tokenIn) as `0x${string}`, spender: RHC.universalRouter, permit2: RHC.permit2 },
      };
    },
    async price(t: string): Promise<PriceQuote> {
      calls.push({ method: "price", args: t });
      const m = meta[norm(t)]!;
      return {
        address: t,
        symbol: m.symbol,
        decimals: m.decimals,
        priceUsd: m.usd,
        via: "usdg",
        venue: "Uniswap v3 · 0.05%",
        block: 100,
      };
    },
    async prices(ts: string[]) {
      return Promise.all(ts.map((t) => engine.price(t)));
    },
    async simulate(p) {
      calls.push({ method: "simulate", args: p });
      return { ok: true, gasEstimate: "21000", error: null, overridden: !!p.fundEth };
    },
    async stockTokens(): Promise<StockTokenList> {
      return {
        tokens: [{ address: NVDA, symbol: "NVDA", name: "NVIDIA", decimals: 18, totalSupply: "1" }],
        scanned: 1,
        checkedAt: "2026-10-25T00:00:00.000Z",
        beacon: "0xe10b6f6b275de231345c20d14ab812db62151b00",
        codehash: "0x6c1fdd40002dcb440c7fff6a84171404d279ccb057803b65826f7546acd65630",
      };
    },
    async isStockToken(a: string) {
      calls.push({ method: "isStockToken", args: a });
      return a.toLowerCase() === NVDA.toLowerCase();
    },
    async hookPassport(h: string): Promise<Passport> {
      return { address: h, risk: { score: 62, rating: "medium", rules: [] } } as unknown as Passport;
    },
    async approvalStatus(owner, token, amount): Promise<ApprovalStatus> {
      calls.push({ method: "approvalStatus", args: { owner, token, amount } });
      return {
        token,
        owner,
        balance: (amount * 2n).toString(),
        permit2Allowance: "0",
        routerAllowance: "0",
        routerAllowanceExpiration: 0,
        missing: opts.approvalsMissing ?? [],
      };
    },
    approvalTxs(token, o = {}) {
      return approvalTxs(token, { ...o, now: 1_700_000_000_000 });
    },
  };
  return engine;
}
