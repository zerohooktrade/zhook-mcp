import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { DEFAULT_POLICY, evaluate, onAllowlist, parsePolicy, refusals, SpendLedger } from "../src/policy.js";
import { AGENT, fakeEngine, USDG } from "./fake.js";

describe("policy", () => {
  it("defaults match the agent-mode page", () => {
    expect(DEFAULT_POLICY).toMatchObject({
      perTradeUsd: 250,
      dailyUsd: 1000,
      maxSlippageBps: 50,
      maxPriceImpactPct: 1,
      hooks: true,
      pinnedHooksOnly: true,
      requireSimulation: true,
      allowVerifiedStockTokens: false,
    });
    expect(onAllowlist(DEFAULT_POLICY, "ETH")).toBe(true);
    expect(onAllowlist(DEFAULT_POLICY, "0x0000000000000000000000000000000000000000")).toBe(true);
    expect(onAllowlist(DEFAULT_POLICY, USDG.toLowerCase())).toBe(true);
  });

  it("loads the policy JSON exported by the app unchanged", () => {
    const exported = {
      name: "desk",
      chainId: 4663,
      api: "https://app.zerohook.trade/api/v1/quote",
      perTradeUsd: 100,
      dailyUsd: 400,
      allowlist: [{ symbol: "ETH", address: "ETH" }],
      maxSlippageBps: 30,
      maxPriceImpactPct: 0.5,
      hooks: false,
      pinnedHooksOnly: true,
      requireSimulation: false,
    };
    expect(parsePolicy(exported)).toMatchObject({ name: "desk", perTradeUsd: 100, hooks: false, feeBps: 0 });
  });

  it.each([
    [{ ...DEFAULT_POLICY, maxSlippageBps: 301 }, "maxSlippageBps"],
    [{ ...DEFAULT_POLICY, perTradeUsd: 0 }, "perTradeUsd"],
    [{ ...DEFAULT_POLICY, allowlist: [{ address: "nope" }] }, "allowlist"],
    [{ ...DEFAULT_POLICY, chainId: 1 }, "chainId"],
    [{ ...DEFAULT_POLICY, feeBps: 51 }, "feeBps"],
    [{ ...DEFAULT_POLICY, feeBps: 10 }, "feeRecipient is required"],
  ])("rejects an invalid policy (%#)", (p, msg) => {
    expect(() => parsePolicy(p)).toThrow(msg);
  });

  it("evaluates every rule and refuses on any failure", async () => {
    const q = await fakeEngine({ impactPct: 3 }).quote({ tokenIn: "ETH", tokenOut: USDG, amount: "0.1", from: AGENT });
    const rules = evaluate(DEFAULT_POLICY, { quote: q, sizeUsd: 300, spentTodayUsd: 800, simulated: true });
    expect(rules.map((r) => r.rule)).toEqual([
      "Sell ETH allowed",
      "Buy USDG allowed",
      "Per-trade cap",
      "Daily cap",
      "Slippage",
      "Price impact",
      "Pinned contracts",
      "Hooks in route",
      "Simulation",
      "Calldata",
    ]);
    expect(refusals(rules).map((r) => r.rule)).toEqual(["Per-trade cap", "Daily cap", "Price impact"]);
  });

  it("refuses an unpriced trade", async () => {
    const q = await fakeEngine().quote({ tokenIn: "ETH", tokenOut: USDG, amount: "1" });
    const rules = evaluate(DEFAULT_POLICY, { quote: q, sizeUsd: null, spentTodayUsd: 0, simulated: false });
    expect(refusals(rules).map((r) => r.rule)).toEqual(["Per-trade cap", "Daily cap"]);
  });
});

describe("spend ledger", () => {
  it("counts a rolling 24 h window and persists to disk", () => {
    const dir = mkdtempSync(join(tmpdir(), "zhook-mcp-"));
    const file = join(dir, "ledger.json");
    let now = 1_000_000_000;
    const l = new SpendLedger(file, () => now);
    l.record({ usd: 100, tokenIn: "ETH", tokenOut: USDG, amount: "0.03" });
    now += 3_600_000;
    l.record({ usd: 50, tokenIn: "ETH", tokenOut: USDG, amount: "0.01" });
    expect(l.spentToday()).toBe(150);
    expect(new SpendLedger(file, () => now).spentToday()).toBe(150);
    now += 86_400_000 - 3_600_000 + 1;
    expect(l.spentToday()).toBe(50);
    expect(JSON.parse(readFileSync(file, "utf8"))).toHaveLength(2);
  });
});

describe("config", () => {
  it("reads RPCs, policy, ledger and pools from the environment", () => {
    const dir = mkdtempSync(join(tmpdir(), "zhook-mcp-"));
    const policyFile = join(dir, "policy.json");
    writeFileSync(policyFile, JSON.stringify({ ...DEFAULT_POLICY, name: "from-file", dailyUsd: 50 }));
    const poolsFile = join(dir, "pools.json");
    const key = {
      currency0: "0x0000000000000000000000000000000000000000",
      currency1: USDG,
      fee: 500,
      tickSpacing: 10,
      hooks: "0x0000000000000000000000000000000000000000",
    };
    writeFileSync(
      poolsFile,
      JSON.stringify({
        pools: [{ key }, ["0x0000000000000000000000000000000000000000", USDG, 3000, 60, "", 0, "0", 0]],
      }),
    );
    const c = loadConfig({
      ZHOOK_RPC_URLS: "https://a.example, https://b.example",
      ZHOOK_POLICY_FILE: policyFile,
      ZHOOK_LEDGER_FILE: join(dir, "ledger.json"),
      ZHOOK_POOLS_FILE: poolsFile,
      ZHOOK_DISCOVER_BLOCKS: "5000",
    });
    expect(c.rpcUrls).toEqual(["https://a.example", "https://b.example"]);
    expect(c.policy.name).toBe("from-file");
    expect(c.policySource).toBe(policyFile);
    expect(c.pools).toHaveLength(2);
    expect(c.pools[0]![2]).toBe(500);
    expect(c.discoverBlocks).toBe(5000);
  });

  it("uses the default policy and public RPCs when nothing is set", () => {
    const c = loadConfig({});
    expect(c).toMatchObject({ rpcUrls: [], policySource: "default", ledgerFile: null, pools: [], discoverBlocks: 0 });
  });

  it("accepts an inline policy and rejects bad values", () => {
    expect(loadConfig({ ZHOOK_POLICY: JSON.stringify({ ...DEFAULT_POLICY, name: "inline" }) }).policy.name).toBe(
      "inline",
    );
    expect(() => loadConfig({ ZHOOK_RPC_URLS: "ftp://x" })).toThrow("not an http(s) URL");
    expect(() => loadConfig({ ZHOOK_DISCOVER_BLOCKS: "-1" })).toThrow("whole number");
    expect(() => loadConfig({ ZHOOK_POLICY_FILE: "/nonexistent/policy.json" })).toThrow("Cannot read spending policy");
  });
});
