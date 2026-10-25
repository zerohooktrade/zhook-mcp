/**
 * Spending policy: the same rules as the agent-mode page of the Zerohook app (per-trade cap, daily cap, token
 * allowlist, max slippage, max price impact, pinned hooks, simulation), enforced before any calldata is returned.
 * The policy JSON exported by that page loads here unchanged.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { MAX_INTEGRATOR_FEE_BPS, MAX_SLIPPAGE_BPS, NATIVE, RHC, type QuoteResponse } from "@zerohooktrade/sdk";
import { z } from "zod";

const address = z.string().regex(/^(ETH|0x[0-9a-fA-F]{40})$/, "an address or ETH");

export const PolicySchema = z.object({
  name: z.string().min(1).default("trading-agent"),
  chainId: z.literal(RHC.id).optional(),
  /** Max USD value of one trade's input. */
  perTradeUsd: z.number().positive(),
  /** Max USD value of all trades in a rolling 24 h. */
  dailyUsd: z.number().positive(),
  /** Tokens the agent may sell or buy. Empty = nothing allowed. */
  allowlist: z.array(z.object({ address, symbol: z.string().optional() })),
  /** Also allow any Robinhood Stock Token verified by exact proxy code. */
  allowVerifiedStockTokens: z.boolean().default(false),
  /** Router-enforced slippage ceiling (1–300 bps). */
  maxSlippageBps: z.number().int().min(1).max(MAX_SLIPPAGE_BPS),
  /** Refuse quotes whose price impact is above this. */
  maxPriceImpactPct: z.number().min(0),
  /** Route through hooked v4 pools. */
  hooks: z.boolean().default(true),
  /** Refuse routes through hooks whose code is not pinned or has changed. */
  pinnedHooksOnly: z.boolean().default(true),
  /** Require a passing eth_call + eth_estimateGas from the agent's wallet. */
  requireSimulation: z.boolean().default(true),
  feeBps: z.number().int().min(0).max(MAX_INTEGRATOR_FEE_BPS).default(0),
  feeRecipient: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/)
    .optional(),
});

export type Policy = z.infer<typeof PolicySchema>;

export const DEFAULT_POLICY: Policy = PolicySchema.parse({
  name: "trading-agent",
  perTradeUsd: 250,
  dailyUsd: 1000,
  allowlist: [
    { address: "ETH", symbol: "ETH" },
    { address: RHC.usdg, symbol: "USDG" },
  ],
  maxSlippageBps: 50,
  maxPriceImpactPct: 1,
});

/** Parse and check a policy object (throws with every problem listed). */
export function parsePolicy(input: unknown): Policy {
  const r = PolicySchema.safeParse(input);
  if (!r.success)
    throw new Error(
      `Invalid spending policy: ${r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    );
  if (r.data.feeBps > 0 && !r.data.feeRecipient)
    throw new Error("Invalid spending policy: feeRecipient is required when feeBps > 0");
  return r.data;
}

const isEth = (a: string) => a.toUpperCase() === "ETH" || a.toLowerCase() === NATIVE;
const lc = (a: string) => a.toLowerCase();

export function onAllowlist(p: Policy, token: string): boolean {
  return p.allowlist.some((t) => (isEth(t.address) && isEth(token)) || lc(t.address) === lc(token));
}

export interface RuleResult {
  rule: string;
  /** true = passes, false = refuses, null = not applicable. */
  ok: boolean | null;
  detail: string;
}

export interface EvaluateInput {
  quote: QuoteResponse;
  /** amountIn × live USD price of tokenIn, null when unpriced. */
  sizeUsd: number | null;
  spentTodayUsd: number;
  /** Whether the quote was simulated from the agent's wallet. */
  simulated: boolean;
  /** Verified Stock Token status of tokenIn / tokenOut (only consulted when the policy allows them). */
  stock?: { in: boolean; out: boolean };
}

const usd = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;

/** Evaluate a quote against the policy. Calldata may be returned only when no rule is false. */
export function evaluate(p: Policy, input: EvaluateInput): RuleResult[] {
  const { quote: q, sizeUsd, spentTodayUsd, simulated, stock } = input;
  const out: RuleResult[] = [];
  const allowed = (addr: string, isStock: boolean | undefined) =>
    onAllowlist(p, addr) ? "on the allowlist" : p.allowVerifiedStockTokens && isStock ? "verified Stock Token" : null;
  const inWhy = allowed(q.tokenIn.address, stock?.in);
  const outWhy = allowed(q.tokenOut.address, stock?.out);
  out.push({ rule: `Sell ${q.tokenIn.symbol} allowed`, ok: !!inWhy, detail: inWhy ?? "not on the allowlist" });
  out.push({ rule: `Buy ${q.tokenOut.symbol} allowed`, ok: !!outWhy, detail: outWhy ?? "not on the allowlist" });
  out.push(
    sizeUsd === null
      ? {
          rule: "Per-trade cap",
          ok: false,
          detail: `${q.tokenIn.symbol} has no live USD price: size can't be checked, so the trade is refused`,
        }
      : { rule: "Per-trade cap", ok: sizeUsd <= p.perTradeUsd, detail: `${usd(sizeUsd)} of ${usd(p.perTradeUsd)}` },
  );
  out.push(
    sizeUsd === null
      ? { rule: "Daily cap", ok: false, detail: "size unknown" }
      : {
          rule: "Daily cap",
          ok: spentTodayUsd + sizeUsd <= p.dailyUsd,
          detail: `${usd(spentTodayUsd + sizeUsd)} of ${usd(p.dailyUsd)} in 24 h (${usd(spentTodayUsd)} already spent)`,
        },
  );
  out.push({
    rule: "Slippage",
    ok: q.slippageBps <= p.maxSlippageBps,
    detail: `${q.slippageBps / 100}% (max ${p.maxSlippageBps / 100}%): minimum received enforced on-chain`,
  });
  out.push(
    q.priceImpactPct === null
      ? { rule: "Price impact", ok: false, detail: "impact could not be measured: refused" }
      : {
          rule: "Price impact",
          ok: q.priceImpactPct <= p.maxPriceImpactPct,
          detail: `${q.priceImpactPct < 0.01 ? "<0.01" : q.priceImpactPct.toFixed(2)}% (max ${p.maxPriceImpactPct}%)`,
        },
  );
  out.push({
    rule: "Pinned contracts",
    ok: q.pinsOk,
    detail: q.pinsOk ? `${q.pins.length}/${q.pins.length} codehashes match` : "a pinned contract's code changed",
  });
  const badHooks = q.hooks.filter((h) => h.status !== "match");
  out.push({
    rule: "Hooks in route",
    ok: !p.pinnedHooksOnly || badHooks.length === 0,
    detail:
      q.hooks.length === 0
        ? "none"
        : badHooks.length === 0
          ? `${q.hooks.length} hook(s), code pinned`
          : `${badHooks.length} hook(s) ${badHooks.map((h) => h.status).join(", ")}${p.pinnedHooksOnly ? "" : ": allowed by policy"}`,
  });
  out.push(
    !p.requireSimulation
      ? { rule: "Simulation", ok: null, detail: "not required by this policy" }
      : !simulated
        ? { rule: "Simulation", ok: null, detail: "runs from the agent wallet in build_swap" }
        : {
            rule: "Simulation",
            ok: !!q.simulation?.ok,
            detail: q.simulation?.ok
              ? `passes · ${Number(q.simulation.gasEstimate).toLocaleString("en-US")} gas`
              : (q.simulation?.error ?? q.txNote ?? "reverted"),
          },
  );
  out.push({
    rule: "Calldata",
    ok: !!q.tx,
    detail: q.tx ? `Universal Router · ${q.tx.commands.join(" → ")}` : (q.txNote ?? "not built"),
  });
  return out;
}

export const refusals = (rules: RuleResult[]) => rules.filter((r) => r.ok === false);

/* ------------------------------------------------------------------ rolling 24 h spend ledger */

export interface Spend {
  at: number;
  usd: number;
  tokenIn: string;
  tokenOut: string;
  amount: string;
}

const DAY_MS = 86_400_000;

/** Spend per rolling 24 h. In memory, or persisted to a JSON file so the daily cap survives restarts. */
export class SpendLedger {
  private entries: Spend[] = [];

  constructor(
    private readonly file: string | null = null,
    private readonly now: () => number = Date.now,
  ) {
    if (file && existsSync(file)) {
      const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
      if (!Array.isArray(raw)) throw new Error(`Spend ledger ${file} is not a JSON array`);
      this.entries = (raw as Spend[]).filter((s) => typeof s.at === "number" && typeof s.usd === "number");
    }
  }

  recent(): Spend[] {
    const since = this.now() - DAY_MS;
    return this.entries.filter((s) => s.at > since);
  }

  spentToday(): number {
    return this.recent().reduce((a, s) => a + s.usd, 0);
  }

  record(spend: Omit<Spend, "at">): void {
    this.entries = [...this.recent(), { ...spend, at: this.now() }];
    if (this.file) writeFileSync(this.file, JSON.stringify(this.entries, null, 2));
  }
}
