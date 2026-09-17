import type { Address } from "viem";

export const ARBITRUM_CHAIN_ID = 42161;
export const ROBINHOOD_MAINNET_CHAIN_ID = 4663;
export const ROBINHOOD_TESTNET_CHAIN_ID = 46630;

export const PERMIT2_ADDRESS =
  "0x000000000022D473030F116dDEE9F6B43aC78BA3" as const satisfies Address;

/** On-chain deployment addresses for a supported chain (see the router contracts README). */
export type ChainDeployments = {
  chainId: number;
  slug: string;
  /** Public RPC when one exists; omit for chains that require a private RPC_URL. */
  defaultRpcUrl?: string;
  permit2: Address;
  swapShell: Address;
  arcusSettlement?: Address;
  arcusRfqExecutor?: Address;
  arcusWrappedEscrow?: Address;
  arcusWrappedExecutor?: Address;
  arcusWrappedTokenFactory?: Address;
  arcusWrappedTokenBeacon?: Address;
  /** Rialto venue router (`SwapExecuted.router` for routeTag "RIALTO"). */
  rialtoRouter?: Address;
  /** LI.FI Permit2Proxy (`SwapExecuted.router` for routeTag "LIFI"). */
  lifiPermit2Proxy?: Address;
  /** 0x venue router (`SwapExecuted.router` for routeTag "ZEROEX"). */
  zeroexRouter?: Address;
};

export const ARBITRUM_DEPLOYMENTS = {
  chainId: ARBITRUM_CHAIN_ID,
  slug: "arbitrum",
  defaultRpcUrl: "https://arb1.arbitrum.io/rpc",
  permit2: PERMIT2_ADDRESS,
  swapShell: "0xF8698CA109583Ea2CBc57EF560d4Be2E0DF349A2",
  rialtoRouter: "0xDE0bA676a93EcbA8bA2B51dEcc9E37e2198efe0E",
  zeroexRouter: "0xfbeCF057d93430a15A936Dd57A7424D4F0A8772b",
} as const satisfies ChainDeployments;

export const ROBINHOOD_MAINNET_DEPLOYMENTS = {
  chainId: ROBINHOOD_MAINNET_CHAIN_ID,
  slug: "robinhood-mainnet",
  permit2: PERMIT2_ADDRESS,
  swapShell: "0x4262efBd176F02824af27010bEa218429c33c7E8",
  arcusSettlement: "0x006102b16A04c20306A28b652745D3973D7D24fa",
  arcusRfqExecutor: "0xf4da3c42D9c9F494d4688A0112a9DB3C9b18a914",
  arcusWrappedEscrow: "0x6d56Ab475069B7E93886b3D3F06c5435B87Ba158",
  arcusWrappedExecutor: "0x43cF43056C33128329B54F66CA3649CF2975f1A6",
  arcusWrappedTokenFactory: "0x8bc71aE8EaC8B25F30c2990930Cc3A80E72e169e",
  arcusWrappedTokenBeacon: "0x27fEB332759F8d2f351D7fC72D29af37664ffd77",
  rialtoRouter: "0xC94135b63772b91D79d0A2DaAb2a8801f32359bD",
  lifiPermit2Proxy: "0x8eABB4E117fB70b346592e013855f6d825F50af1",
} as const satisfies ChainDeployments;

export const ROBINHOOD_TESTNET_DEPLOYMENTS = {
  chainId: ROBINHOOD_TESTNET_CHAIN_ID,
  slug: "robinhood-testnet",
  defaultRpcUrl: "https://rpc.testnet.chain.robinhood.com",
  permit2: PERMIT2_ADDRESS,
  swapShell: "0x528B30910B3ef5a615cDC3847F273947dc474519",
  arcusSettlement: "0xE8D8b187754D8a5Ca4Ea4E77Cd01506f9332A773",
  arcusRfqExecutor: "0x38Cebc5F641d3A0dd39969B0B75937d267dA0D85",
  arcusWrappedEscrow: "0x391747585Caebd163D2D0B980B79B0Ba312A5742",
  arcusWrappedExecutor: "0x9956eb7C004d51e29a51f1C68be8e198A1DCFA5d",
  arcusWrappedTokenFactory: "0xF361dD4cd631175648f54B657d44A3128903D92c",
  arcusWrappedTokenBeacon: "0xDd70cD7BbE53ac3d67c1959C9De84423f5Bf2bca",
} as const satisfies ChainDeployments;

export const CHAIN_DEPLOYMENTS_BY_ID: Readonly<Partial<Record<number, ChainDeployments>>> = {
  [ARBITRUM_CHAIN_ID]: ARBITRUM_DEPLOYMENTS,
  [ROBINHOOD_MAINNET_CHAIN_ID]: ROBINHOOD_MAINNET_DEPLOYMENTS,
  [ROBINHOOD_TESTNET_CHAIN_ID]: ROBINHOOD_TESTNET_DEPLOYMENTS,
};

export function getChainDeployments(chainId: number): ChainDeployments | undefined {
  return CHAIN_DEPLOYMENTS_BY_ID[chainId];
}

/**
 * Every deployed contract that can appear as the ERC-20 `Transfer.from` when a
 * swap delivers the bought token to the taker's wallet. All venues custody the
 * buy-side leg and forward it from their router contract (the address emitted
 * as `SwapExecuted.router`), so this set lets consumers distinguish swap
 * settlements from genuine inbound transfers (e.g. deposits).
 *
 * Returned lowercased for case-insensitive comparison against log topics.
 */
export function getSettlementSourceAddresses(chainId: number): readonly Address[] {
  const deployments = CHAIN_DEPLOYMENTS_BY_ID[chainId];
  if (!deployments) return [];
  const sources: (Address | undefined)[] = [
    deployments.swapShell,
    deployments.arcusSettlement,
    deployments.arcusRfqExecutor,
    deployments.arcusWrappedEscrow,
    deployments.arcusWrappedExecutor,
    deployments.rialtoRouter,
    deployments.lifiPermit2Proxy,
    deployments.zeroexRouter,
  ];
  return sources
    .filter((address): address is Address => address != null)
    .map((address) => address.toLowerCase() as Address);
}
