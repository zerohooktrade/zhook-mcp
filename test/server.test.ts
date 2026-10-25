import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { decodeFunctionData, getAddress } from "viem";
import { erc20Abi, RHC } from "@zhooktrade/sdk";
import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY, parsePolicy, SpendLedger, type Policy } from "../src/policy.js";
import { createServer } from "../src/server.js";
import { AGENT, fakeEngine, HOOK, MEME, NVDA, USDG, type FakeOptions } from "./fake.js";

type Result = {
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
  content: { type: string; text: string }[];
};

async function connect(opts: FakeOptions = {}, policy: Policy = DEFAULT_POLICY, ledger = new SpendLedger()) {
  const zhook = fakeEngine(opts);
  const server = createServer({ zhook, policy, ledger });
  const client = new Client({ name: "test", version: "0.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as Result;
    const text = r.content[0]!.text;
    let body: Record<string, unknown>;
    try {
      body = (r.structuredContent ?? JSON.parse(text)) as Record<string, unknown>;
    } catch {
      body = { error: text };
    }
    return { isError: !!r.isError, body };
  };
  return { client, call, zhook, ledger };
}

describe("tools", () => {
  it("registers exactly the read-only and calldata tools", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        "build_swap",
        "hook_passport",
        "list_hook_pools",
        "quote",
        "simulate",
        "spending_policy",
        "stock_tokens",
        "token_price",
      ].sort(),
    );
    for (const t of tools) expect(t.description!.length).toBeGreaterThan(40);
  });

  it("quote returns a route and a policy preview, never calldata", async () => {
    const { call } = await connect();
    const { isError, body } = await call("quote", { tokenIn: "ETH", tokenOut: USDG, amount: "0.05" });
    expect(isError).toBe(false);
    expect(JSON.stringify(body)).not.toContain("0xdeadbeef");
    expect(body).toMatchObject({ sizeUsd: 150, policy: { wouldAllow: true } });
    expect((body.quote as { route: { hops: string[] }[] }).route[0]!.hops[0]).toContain("Uniswap v3 0.05%");
  });

  it("rejects malformed input at the schema", async () => {
    const { call } = await connect();
    expect((await call("quote", { tokenIn: "ETH", tokenOut: USDG, amount: "-1" })).isError).toBe(true);
    expect((await call("build_swap", { tokenIn: "ETH", tokenOut: USDG, amount: "1", from: "0x12" })).isError).toBe(
      true,
    );
    expect((await call("quote", { tokenIn: "ETH", tokenOut: USDG, amount: "1", slippageBps: 301 })).isError).toBe(true);
  });
});

describe("build_swap under the spending policy", () => {
  const eth = { tokenIn: "ETH", tokenOut: USDG, from: AGENT };

  it("returns simulated calldata and adds the trade to the daily spend", async () => {
    const { call, ledger, zhook } = await connect();
    const { isError, body } = await call("build_swap", { ...eth, amount: "0.05" });
    expect(isError).toBe(false);
    expect(body).toMatchObject({
      status: "ready",
      chainId: 4663,
      tx: { to: RHC.universalRouter, data: "0xdeadbeef", value: "0", from: AGENT },
      sizeUsd: 150,
      spentTodayUsd: 150,
    });
    expect(ledger.spentToday()).toBe(150);
    const q = zhook.calls.find((c) => c.method === "quote")!.args as Record<string, unknown>;
    expect(q).toMatchObject({ from: AGENT, slippageBps: 50, hooks: true, pinnedHooksOnly: true });
  });

  it("refuses above the per-trade cap", async () => {
    const { call, ledger } = await connect();
    const { isError, body } = await call("build_swap", { ...eth, amount: "0.1" });
    expect(isError).toBe(true);
    expect((body.refusedBy as { rule: string }[]).map((r) => r.rule)).toEqual(["Per-trade cap"]);
    expect(ledger.spentToday()).toBe(0);
  });

  it("refuses once the rolling daily cap is used up", async () => {
    const { call } = await connect();
    for (let i = 0; i < 4; i++) expect((await call("build_swap", { ...eth, amount: "0.08" })).isError).toBe(false);
    const { isError, body } = await call("build_swap", { ...eth, amount: "0.08" });
    expect(isError).toBe(true);
    expect((body.refusedBy as { rule: string }[]).map((r) => r.rule)).toEqual(["Daily cap"]);
    const s = await call("spending_policy");
    expect(s.body).toMatchObject({ spentTodayUsd: 960, tradesInWindow: 4 });
    expect(s.body.remainingTodayUsd).toBeCloseTo(40);
  });

  it("refuses a token off the allowlist without touching the chain", async () => {
    const { call, zhook } = await connect();
    const { isError, body } = await call("build_swap", { ...eth, tokenOut: MEME, amount: "0.01" });
    expect(isError).toBe(true);
    expect(body.error).toContain("not on the allowlist");
    expect(zhook.calls).toEqual([]);
  });

  it("refuses slippage above the policy", async () => {
    const { call } = await connect();
    const { isError, body } = await call("build_swap", { ...eth, amount: "0.01", slippageBps: 100 });
    expect(isError).toBe(true);
    expect(body.error).toContain("above the policy's 50 bps");
  });

  it.each([
    [{ impactPct: 1.5 }, "Price impact"],
    [{ impactPct: null }, "Price impact"],
    [{ pinsOk: false }, "Pinned contracts"],
    [{ hookStatus: "changed" as const }, "Hooks in route"],
    [{ simulationOk: false }, "Simulation"],
  ] as [FakeOptions, string][])("refuses when %o", async (opts, rule) => {
    const { call, ledger } = await connect(opts);
    const { isError, body } = await call("build_swap", { ...eth, amount: "0.01" });
    expect(isError).toBe(true);
    expect((body.refusedBy as { rule: string }[]).map((r) => r.rule)).toContain(rule);
    expect(ledger.spentToday()).toBe(0);
  });

  it("allows an unpinned hook when the policy does not require pins", async () => {
    const { call } = await connect({ hookStatus: "new" }, parsePolicy({ ...DEFAULT_POLICY, pinnedHooksOnly: false }));
    expect((await call("build_swap", { ...eth, amount: "0.01" })).isError).toBe(false);
  });

  it("hands out exact-amount approvals first for ERC-20 input, without recording spend", async () => {
    const { call, ledger } = await connect({ approvalsMissing: ["erc20-approve-permit2", "permit2-approve-router"] });
    const { isError, body } = await call("build_swap", { tokenIn: USDG, tokenOut: "ETH", amount: "100", from: AGENT });
    expect(isError).toBe(false);
    expect(body.status).toBe("needs_approval");
    const approvals = body.approvals as { to: string; data: `0x${string}` }[];
    expect(approvals.map((a) => a.to)).toEqual([USDG.toLowerCase(), RHC.permit2]);
    expect(decodeFunctionData({ abi: erc20Abi, data: approvals[0]!.data }).args).toEqual([
      getAddress(RHC.permit2),
      100_000_000n,
    ]);
    expect(ledger.spentToday()).toBe(0);
  });

  it("returns swap calldata for ERC-20 input once approvals exist", async () => {
    const { call } = await connect();
    const { isError, body } = await call("build_swap", { tokenIn: USDG, tokenOut: "ETH", amount: "100", from: AGENT });
    expect(isError).toBe(false);
    expect(body).toMatchObject({ status: "ready", sizeUsd: 100 });
  });

  it("allows verified Stock Tokens when the policy says so", async () => {
    const strict = await connect();
    expect(
      (await strict.call("build_swap", { tokenIn: USDG, tokenOut: NVDA, amount: "20", from: AGENT })).isError,
    ).toBe(true);
    const open = await connect({}, parsePolicy({ ...DEFAULT_POLICY, allowVerifiedStockTokens: true }));
    const r = await open.call("build_swap", { tokenIn: USDG, tokenOut: NVDA, amount: "20", from: AGENT });
    expect(r.isError).toBe(false);
    const rules = r.body.rules as { rule: string; detail: string }[];
    expect(rules.find((x) => x.rule === "Buy NVDA allowed")?.detail).toBe("verified Stock Token");
    const fake = await open.call("build_swap", { tokenIn: USDG, tokenOut: MEME, amount: "20", from: AGENT });
    expect(fake.isError).toBe(true);
  });
});

describe("read tools", () => {
  it("simulate passes the call through", async () => {
    const { call } = await connect();
    const { body } = await call("simulate", {
      from: AGENT,
      to: RHC.universalRouter,
      data: "0x1234",
      value: "5",
      fundEth: true,
    });
    expect(body).toMatchObject({ ok: true, gasEstimate: "21000", overridden: true, value: "5" });
  });

  it("list_hook_pools ranks hooks and lists a hook's pools", async () => {
    const { call } = await connect();
    const all = await call("list_hook_pools");
    expect(all.body).toMatchObject({ total: 1, hooks: [{ hook: HOOK, pools: 2, swaps: 42 }] });
    const one = await call("list_hook_pools", { hook: HOOK, token: NVDA });
    expect(one.body).toMatchObject({ total: 1, pools: [{ fee: "0.3%", swaps: 2 }] });
  });

  it("hook_passport, token_price and stock_tokens answer", async () => {
    const { call } = await connect();
    expect((await call("hook_passport", { hook: HOOK })).body).toMatchObject({ risk: { score: 62 } });
    const px = await call("token_price", { tokens: ["ETH", USDG, "ETH"] });
    expect((px.body.prices as unknown[]).length).toBe(2);
    const st = await call("stock_tokens");
    expect(st.body).toMatchObject({ count: 1, tokens: [{ symbol: "NVDA", tradableUnderPolicy: false }] });
  });
});
