#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createZhook } from "@zerohooktrade/sdk";
import { loadConfig } from "./config.js";
import { log } from "./log.js";
import { SpendLedger } from "./policy.js";
import { createServer, SERVER_VERSION } from "./server.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const zhook = createZhook({
    ...(config.rpcUrls.length ? { rpcUrls: config.rpcUrls } : {}),
    ...(config.pools.length ? { pools: config.pools } : {}),
  });
  const ledger = new SpendLedger(config.ledgerFile);
  const server = createServer({ zhook, policy: config.policy, policySource: config.policySource, ledger });
  await server.connect(new StdioServerTransport());
  log(
    `v${SERVER_VERSION} ready: ${zhook.registry.size} v4 pools, policy "${config.policy.name}" (${config.policySource}), ` +
      `per trade $${config.policy.perTradeUsd}, daily $${config.policy.dailyUsd}${config.ledgerFile ? ", ledger on disk" : ""}`,
  );
  if (config.discoverBlocks > 0)
    zhook
      .discoverPools({ blocks: config.discoverBlocks })
      .then((r) =>
        log(
          `discovered ${r.pools.length} pools in blocks ${r.fromBlock}-${r.toBlock}${r.complete ? "" : ` (partial: ${r.error})`}`,
        ),
      )
      .catch((e: unknown) => log("pool discovery failed:", (e as Error).message));
}

main().catch((error: unknown) => {
  log("failed to start:", error instanceof Error ? error.message : error);
  process.exit(1);
});
