import { readFileSync } from "node:fs";
import { inputToRow, type PoolRow } from "@zhooktrade/sdk";
import { DEFAULT_POLICY, parsePolicy, type Policy } from "./policy.js";

export interface Config {
  rpcUrls: string[];
  policy: Policy;
  policySource: string;
  ledgerFile: string | null;
  pools: PoolRow[];
  discoverBlocks: number;
}

const readJson = (path: string, what: string): unknown => {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (e) {
    throw new Error(`Cannot read ${what} from ${path}: ${(e as Error).message}`, { cause: e });
  }
};

/**
 * Configuration from environment variables:
 *  - ZHOOK_RPC_URLS: comma-separated read RPCs (default: public Robinhood Chain RPCs)
 *  - ZHOOK_POLICY_FILE: spending policy JSON file (the agent-mode page's export works as is)
 *  - ZHOOK_POLICY: the same policy as an inline JSON string
 *  - ZHOOK_LEDGER_FILE: JSON file that keeps the rolling 24 h spend across restarts
 *  - ZHOOK_POOLS_FILE: extra v4 pools, as compact rows or { key } objects
 *  - ZHOOK_DISCOVER_BLOCKS: scan this many recent blocks for new pools at start (0 = off)
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const rpcUrls = (env.ZHOOK_RPC_URLS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const u of rpcUrls) if (!/^https?:\/\//.test(u)) throw new Error(`ZHOOK_RPC_URLS: not an http(s) URL: ${u}`);

  let policy = DEFAULT_POLICY;
  let policySource = "default";
  if (env.ZHOOK_POLICY_FILE) {
    policy = parsePolicy(readJson(env.ZHOOK_POLICY_FILE, "spending policy"));
    policySource = env.ZHOOK_POLICY_FILE;
  } else if (env.ZHOOK_POLICY) {
    policy = parsePolicy(JSON.parse(env.ZHOOK_POLICY) as unknown);
    policySource = "ZHOOK_POLICY";
  }

  let pools: PoolRow[] = [];
  if (env.ZHOOK_POOLS_FILE) {
    const raw = readJson(env.ZHOOK_POOLS_FILE, "pool list");
    const list = Array.isArray(raw) ? raw : (raw as { pools?: unknown }).pools;
    if (!Array.isArray(list)) throw new Error("ZHOOK_POOLS_FILE must hold an array of pools or { pools: [...] }");
    pools = list.map((p) => (Array.isArray(p) ? (p as PoolRow) : inputToRow(p as Parameters<typeof inputToRow>[0])));
  }

  const discoverBlocks = Number(env.ZHOOK_DISCOVER_BLOCKS ?? 0);
  if (!Number.isInteger(discoverBlocks) || discoverBlocks < 0)
    throw new Error("ZHOOK_DISCOVER_BLOCKS must be a whole number");

  return { rpcUrls, policy, policySource, ledgerFile: env.ZHOOK_LEDGER_FILE || null, pools, discoverBlocks };
}
