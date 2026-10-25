import type { Zhook } from "@zhooktrade/sdk";
import type { Policy, SpendLedger } from "./policy.js";

/** The part of the SDK router the tools use (a fake can stand in for it in tests). */
export type Engine = Pick<
  Zhook,
  | "quote"
  | "simulate"
  | "price"
  | "prices"
  | "stockTokens"
  | "isStockToken"
  | "hookPassport"
  | "approvalStatus"
  | "approvalTxs"
  | "registry"
>;

export interface Deps {
  zhook: Engine;
  policy: Policy;
  policySource?: string;
  ledger: SpendLedger;
}
