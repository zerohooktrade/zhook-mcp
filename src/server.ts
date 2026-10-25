import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { MAX_SLIPPAGE_BPS } from "@zhooktrade/sdk";
import { z } from "zod";
import type { Deps } from "./engine.js";
import { buildSwapHandler } from "./tools/buildSwap.js";
import { run } from "./tools/errors.js";
import { hookPassportHandler, listHookPoolsHandler } from "./tools/hooks.js";
import { stockTokensHandler, tokenPriceHandler } from "./tools/market.js";
import { spendingPolicyHandler } from "./tools/policy.js";
import { quoteHandler } from "./tools/quote.js";
import { simulateHandler } from "./tools/simulate.js";

export const SERVER_NAME = "zhook-mcp";
export const SERVER_VERSION = "0.1.0";

const token = z
  .string()
  .regex(/^(ETH|eth|0x[0-9a-fA-F]{40})$/, "a token address, or ETH for native ETH")
  .describe('Token address on Robinhood Chain, or "ETH" for native ETH.');
const wallet = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "an address");
const amount = z
  .string()
  .regex(/^\d+(\.\d+)?$/, "a positive decimal")
  .describe('Amount of tokenIn as a decimal string in whole-token units, e.g. "0.25".');
const slippage = z
  .number()
  .int()
  .min(1)
  .max(MAX_SLIPPAGE_BPS)
  .optional()
  .describe("Slippage in basis points. Defaults to the policy maximum; above it the trade is refused.");

/**
 * Builds the MCP server with every Zerohook tool registered. Transport wiring lives in index.ts so tests can connect
 * an in-memory client. Read-only: no tool holds a key, signs or sends.
 */
export function createServer(deps: Deps): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        "Best-price trading on Robinhood Chain (chain id 4663) across Uniswap v3, v4 and hooked v4 pools. Call quote to compare routes, build_swap for policy-checked Universal Router calldata that the agent's own wallet signs, and spending_policy to see the limits. This server never holds keys and never sends transactions.",
    },
  );

  server.registerTool(
    "quote",
    {
      title: "Quote a swap",
      description:
        "Best route for a swap on Robinhood Chain across Uniswap v3 (4 fee tiers), v4 and hooked v4 pools, including splits and two-hop routes via USDG or ETH. Returns amounts, minimum received, price impact, pinned-code and hook checks, warnings, and a preview of the spending-policy verdict. Never returns calldata.",
      inputSchema: { tokenIn: token, tokenOut: token, amount, slippageBps: slippage },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (args) => run(() => quoteHandler(deps, args)),
  );

  server.registerTool(
    "build_swap",
    {
      title: "Build swap calldata under the spending policy",
      description:
        "Quote, enforce the spending policy (allowlist, per-trade cap, daily cap, max slippage, max price impact, pinned contracts and hooks), simulate from the agent wallet, and return Universal Router calldata for that wallet to sign. ERC-20 input without Permit2 allowances returns the approval calldata first. Refusals list every rule that failed. The trade's USD size counts toward the daily cap once calldata is returned.",
      inputSchema: {
        tokenIn: token,
        tokenOut: token,
        amount,
        from: wallet.describe("The agent wallet that will sign and send. Calldata is simulated from it."),
        slippageBps: slippage,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    (args) => run(() => buildSwapHandler(deps, args)),
  );

  server.registerTool(
    "simulate",
    {
      title: "Simulate a transaction",
      description:
        "Run a transaction with eth_call from a wallet and estimate its gas, without sending it. Returns ok, gasEstimate and the revert reason when it fails. fundEth gives the wallet enough ETH through a state override for a dry run.",
      inputSchema: {
        from: wallet.describe("Sender to simulate from."),
        to: wallet.describe("Target contract."),
        data: z
          .string()
          .regex(/^0x([0-9a-fA-F]{2})*$/, "hex calldata")
          .describe("Calldata (0x-prefixed hex)."),
        value: z.string().regex(/^\d+$/, "wei as a decimal string").optional().describe("msg.value in wei."),
        fundEth: z.boolean().optional().describe("Override the sender's ETH balance for a dry run."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (args) => run(() => simulateHandler(deps, args)),
  );

  server.registerTool(
    "list_hook_pools",
    {
      title: "List Uniswap v4 hooks and their pools",
      description:
        "Hooks in the server's pool list ranked by swaps, with pool counts, tokens and recorded codehash pins. Pass a hook to list its pools, or a token to filter.",
      inputSchema: {
        hook: wallet.optional().describe("Hook contract address: list its pools."),
        token: wallet.optional().describe("Only hooks or pools that trade this token."),
        limit: z.number().int().min(1).max(200).optional().describe("Max rows (default 25)."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) => run(() => listHookPoolsHandler(deps, args)),
  );

  server.registerTool(
    "hook_passport",
    {
      title: "Hook Passport",
      description:
        "What a Uniswap v4 hook can do, read from public on-chain data: permission flags from its address, proxy and owner, Sourcify verification, admin-style functions in its bytecode, pools in the list, and a rule-based risk score with every rule that fired.",
      inputSchema: { hook: wallet.describe("Hook contract address.") },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (args) => run(() => hookPassportHandler(deps, args)),
  );

  server.registerTool(
    "token_price",
    {
      title: "Token USD prices",
      description:
        "USD price per whole token from live Uniswap v3/v4 quotes, directly against USDG or via ETH (USDG counts as 1 USD). Up to 30 tokens.",
      inputSchema: { tokens: z.array(token).min(1).max(30).describe("Token addresses, or ETH.") },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (args) => run(() => tokenPriceHandler(deps, args)),
  );

  server.registerTool(
    "stock_tokens",
    {
      title: "Verified Robinhood Stock Tokens",
      description:
        "Robinhood Stock Tokens on Robinhood Chain, listed only when the contract's runtime code exactly matches the official Stock Token proxy (copycats with the same symbol are never listed), with whether the spending policy allows trading each.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    () => run(() => stockTokensHandler(deps)),
  );

  server.registerTool(
    "spending_policy",
    {
      title: "Spending policy",
      description:
        "The spending policy this server enforces before returning calldata, the USD spent in the rolling 24 h window and what is left of the daily cap.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    () => run(() => spendingPolicyHandler(deps)),
  );

  return server;
}
