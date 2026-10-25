# @zerohooktrade/mcp

A [Model Context Protocol](https://modelcontextprotocol.io) server that lets an agent trade on **Robinhood Chain** (chain id 4663) through the [Zerohook](https://zerohook.trade) routing engine ([`@zerohooktrade/sdk`](https://github.com/zerohooktrade/zhook-sdk)), under a **spending policy** enforced before any calldata leaves the server.

- **Read-only and calldata only.** The server never holds a key, never signs and never sends. The agent's own wallet signs what `build_swap` returns.
- **Best price** across Uniswap v3 (all four fee tiers), v4 and hooked v4 pools, with splits and two-hop routes through USDG or ETH.
- **Spending policy**: per-trade cap, rolling 24 h cap, token allowlist, max slippage, max price impact, pinned contracts and hooks, and an `eth_call` simulation from the agent wallet. The same rules as the agent-mode page of the [app](https://dapp.zerohook.trade); the policy JSON it exports loads here unchanged.
- **stdio** transport. Logs go to stderr only.

Links: app [dapp.zerohook.trade](https://dapp.zerohook.trade) · docs [docs.zerohook.trade](https://docs.zerohook.trade) · site [zerohook.trade](https://zerohook.trade).

## Install

The server depends on the SDK as a sibling folder (`file:../zhook-sdk`):

```sh
git clone https://github.com/zerohooktrade/zhook-sdk.git
git clone https://github.com/zerohooktrade/zhook-mcp.git
(cd zhook-sdk && pnpm install && pnpm build)
cd zhook-mcp && pnpm install && pnpm build
```

Requires Node 20 or later.

## Connect an MCP client

Any client that launches stdio servers works. A typical `mcpServers` entry:

```json
{
  "mcpServers": {
    "zerohook": {
      "command": "node",
      "args": ["/absolute/path/to/zhook-mcp/dist/index.js"],
      "env": {
        "ZHOOK_POLICY_FILE": "/absolute/path/to/policy.json",
        "ZHOOK_LEDGER_FILE": "/absolute/path/to/spend-ledger.json"
      }
    }
  }
}
```

## Configuration

| Variable                | Meaning                                                                                            | Default               |
| ----------------------- | -------------------------------------------------------------------------------------------------- | --------------------- |
| `ZHOOK_POLICY_FILE`     | Spending policy JSON file                                                                          | built-in policy below |
| `ZHOOK_POLICY`          | The same policy as an inline JSON string                                                           |                       |
| `ZHOOK_LEDGER_FILE`     | JSON file keeping the rolling 24 h spend across restarts                                           | in memory             |
| `ZHOOK_RPC_URLS`        | Comma-separated Robinhood Chain read RPCs                                                          | public RPCs           |
| `ZHOOK_POOLS_FILE`      | Extra v4 pools: an array (or `{ "pools": [...] }`) of compact rows or `{ "key": PoolKey }` objects | none                  |
| `ZHOOK_DISCOVER_BLOCKS` | Scan this many recent blocks for new pools at start                                                | `0` (off)             |

The SDK's bundled default pool set is always loaded; the pools file and discovery add to it.

## Spending policy

```json
{
  "name": "trading-agent",
  "perTradeUsd": 250,
  "dailyUsd": 1000,
  "allowlist": [
    { "symbol": "ETH", "address": "ETH" },
    { "symbol": "USDG", "address": "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" }
  ],
  "allowVerifiedStockTokens": false,
  "maxSlippageBps": 50,
  "maxPriceImpactPct": 1,
  "hooks": true,
  "pinnedHooksOnly": true,
  "requireSimulation": true
}
```

This is the built-in default. Fields:

| Field                      | Rule                                                                                          |
| -------------------------- | --------------------------------------------------------------------------------------------- |
| `perTradeUsd`              | Refuse when amount × live USD price of `tokenIn` is above this. An unpriced token is refused. |
| `dailyUsd`                 | Refuse when the rolling 24 h total plus this trade is above this.                             |
| `allowlist`                | Both tokens must be listed (`"ETH"` for native ETH). An empty list refuses everything.        |
| `allowVerifiedStockTokens` | Also allow any Robinhood Stock Token whose contract code exactly matches the official proxy.  |
| `maxSlippageBps`           | Ceiling for slippage (1–300). The minimum received is enforced on-chain by the router.        |
| `maxPriceImpactPct`        | Refuse above this impact, or when impact cannot be measured.                                  |
| `hooks`                    | Route through hooked v4 pools.                                                                |
| `pinnedHooksOnly`          | Refuse routes through a hook whose code is not pinned or has changed.                         |
| `requireSimulation`        | Refuse unless the calldata passes `eth_call` and `eth_estimateGas` from the agent wallet.     |
| `feeBps`, `feeRecipient`   | Optional integrator fee (0–50 bps).                                                           |

Every pinned contract (Universal Router, Permit2, v4 PoolManager, quoters, v3 factory, WETH9, USDG) must match its recorded codehash, always.

The trade's USD size is added to the ledger when `build_swap` returns calldata, whether or not the agent then sends it, so the cap can only be under-used, never exceeded.

## Tools

| Tool              | Input                                                   | Returns                                                                                                                                                                                                            |
| ----------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `quote`           | `tokenIn`, `tokenOut`, `amount`, `slippageBps?`         | Route, amounts, minimum received, price impact, pin and hook checks, warnings, and the policy verdict preview. **No calldata.**                                                                                    |
| `build_swap`      | `tokenIn`, `tokenOut`, `amount`, `from`, `slippageBps?` | `status: "ready"` with `tx { to, data, value }` for the agent wallet, or `status: "needs_approval"` with Permit2 approval calldata (exact amount) for ERC-20 input. Refusals are errors listing every failed rule. |
| `simulate`        | `from`, `to`, `data`, `value?`, `fundEth?`              | `eth_call` + gas estimate; revert reason on failure.                                                                                                                                                               |
| `list_hook_pools` | `hook?`, `token?`, `limit?`                             | Hooks ranked by swaps with codehash pins, or one hook's pools.                                                                                                                                                     |
| `hook_passport`   | `hook`                                                  | Permission flags, proxy, owner, Sourcify status, admin-style functions, risk score and rules.                                                                                                                      |
| `token_price`     | `tokens` (up to 30)                                     | USD price per whole token from live Uniswap quotes (USDG = 1).                                                                                                                                                     |
| `stock_tokens`    | none                                                    | Robinhood Stock Tokens verified by exact proxy code, with `tradableUnderPolicy`.                                                                                                                                   |
| `spending_policy` | none                                                    | Active policy, spend in the rolling 24 h window, remaining daily cap.                                                                                                                                              |

Tokens are addresses on Robinhood Chain, or `"ETH"` for native ETH. Amounts are decimal strings in whole-token units.

### Typical flow

1. `quote` to see the route and whether the policy would allow it.
2. `build_swap` with the agent wallet as `from`.
3. If `needs_approval`: sign and send the approvals, then call `build_swap` again.
4. Sign and send `tx` before `deadline`. The router reverts if fewer than `minOut` tokens arrive.

## Limits

- Exact-input swaps only; one chain (Robinhood Chain).
- The ledger is per server process unless `ZHOOK_LEDGER_FILE` is set. Two servers sharing one wallet should share one ledger file, and not run at the same time.
- Prices for the caps come from live Uniswap quotes; USDG is counted as 1 USD.
- Public RPCs rate-limit; set `ZHOOK_RPC_URLS` for heavy use.
- v4 routing covers the pool list in use (default set, pools file, discovery). See the SDK README for routing limits.

## Development

```sh
pnpm lint && pnpm typecheck && pnpm build && pnpm test
```

Tests drive the real MCP protocol through an in-memory client against a deterministic engine, and spawn the built server over stdio to check that stdout carries only JSON-RPC.

## License

MIT © Zerohook
