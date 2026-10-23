import {
  decodeEventLog,
  encodeEventTopics,
  formatLog,
  numberToHex,
  toEventSelector,
  type Address,
  type Hex,
  type Log,
  type PublicClient,
} from "viem";
import { getSwapShellAddress } from "./constants.js";

/**
 * SwapShell's `SwapExecuted` event as emitted by the current Robinhood mainnet and
 * testnet implementations, which carry the caller's public API-key id.
 */
export const swapShellAbi = [
  {
    type: "event",
    name: "SwapExecuted",
    inputs: [
      { name: "taker", type: "address", indexed: true },
      { name: "tokenIn", type: "address", indexed: true },
      { name: "tokenOut", type: "address", indexed: true },
      { name: "minAmountOut", type: "uint256", indexed: false },
      { name: "amountIn", type: "uint256", indexed: false },
      { name: "quotedAmountIn", type: "uint256", indexed: false },
      { name: "quotedAmountOut", type: "uint256", indexed: false },
      { name: "amountOut", type: "uint256", indexed: false },
      { name: "tokenInBenchmarkPrice", type: "uint256", indexed: false },
      { name: "tokenOutBenchmarkPrice", type: "uint256", indexed: false },
      { name: "router", type: "address", indexed: false },
      { name: "routeTag", type: "bytes32", indexed: false },
      { name: "apiKeyId", type: "string", indexed: false },
      { name: "success", type: "bool", indexed: false },
      { name: "reason", type: "string", indexed: false },
    ],
  },
] as const;

/**
 * The earlier `SwapExecuted` shape without `apiKeyId`: logs from SwapShell
 * implementations before that field was added (and the Arbitrum deployment).
 */
export const swapShellLegacyAbi = [
  {
    type: "event",
    name: "SwapExecuted",
    inputs: [
      { name: "taker", type: "address", indexed: true },
      { name: "tokenIn", type: "address", indexed: true },
      { name: "tokenOut", type: "address", indexed: true },
      { name: "minAmountOut", type: "uint256", indexed: false },
      { name: "amountIn", type: "uint256", indexed: false },
      { name: "quotedAmountIn", type: "uint256", indexed: false },
      { name: "quotedAmountOut", type: "uint256", indexed: false },
      { name: "amountOut", type: "uint256", indexed: false },
      { name: "tokenInBenchmarkPrice", type: "uint256", indexed: false },
      { name: "tokenOutBenchmarkPrice", type: "uint256", indexed: false },
      { name: "router", type: "address", indexed: false },
      { name: "routeTag", type: "bytes32", indexed: false },
      { name: "success", type: "bool", indexed: false },
      { name: "reason", type: "string", indexed: false },
    ],
  },
] as const;

const swapExecutedAbis = [...swapShellAbi, ...swapShellLegacyAbi] as const;

export type SwapExecutedArgs = {
  taker: Address;
  tokenIn: Address;
  tokenOut: Address;
  minAmountOut: bigint;
  amountIn: bigint;
  quotedAmountIn: bigint;
  quotedAmountOut: bigint;
  amountOut: bigint;
  tokenInBenchmarkPrice: bigint;
  tokenOutBenchmarkPrice: bigint;
  router: Address;
  routeTag: Hex;
  /** Public API-key id; undefined on logs in the legacy event shape. */
  apiKeyId?: string;
  success: boolean;
  reason: string;
};

export type DecodedSwapExecutedLog = {
  address: Address;
  blockHash: Hex | null;
  blockNumber: bigint | null;
  logIndex: number | null;
  transactionHash: Hex | null;
  transactionIndex: number | null;
  args: SwapExecutedArgs;
};

export type SwapShellTradeHistoryRequest = {
  publicClient: PublicClient;
  /**
   * Defaults from SWAP_SHELL_BY_CHAIN_ID when omitted. Pass this explicitly for
   * local/test deployments or when querying a non-default SwapShell.
   */
  swapShell?: Address;
  /**
   * Used to resolve the default SwapShell address. If omitted, the helper uses
   * publicClient.chain.id when available.
   */
  chainId?: number;
  taker: Address;
  /**
   * Always bound eth_getLogs queries and page through larger histories.
   * Many RPC providers cap log ranges by plan; free tiers may allow only a
   * handful of blocks per request.
   */
  fromBlock: bigint;
  /**
   * Prefer an explicit end block for repeatable pagination. "latest" is
   * supported for small lookups, but broad ranges can be rejected by the RPC.
   */
  toBlock?: bigint | "latest";
  tokenIn?: Address;
  tokenOut?: Address;
};

/**
 * Fetch decoded SwapExecuted logs for one taker. Callers should pass a narrow
 * fromBlock/toBlock window and paginate, because eth_getLogs limits vary by
 * provider and subscription plan.
 */
export async function getSwapShellTradeHistory({
  publicClient,
  swapShell,
  chainId,
  taker,
  fromBlock,
  toBlock = "latest",
  tokenIn,
  tokenOut,
}: SwapShellTradeHistoryRequest): Promise<DecodedSwapExecutedLog[]> {
  const resolvedSwapShell =
    swapShell ?? getSwapShellAddress(chainId ?? publicClient.chain?.id ?? 0);
  if (!resolvedSwapShell) {
    throw new Error("SwapShell address is required for this chain");
  }

  // One eth_getLogs call matching both event shapes (topic0 OR-list); the indexed
  // taker/tokenIn/tokenOut topics are identical in both.
  const [currentTopic0, ...indexedTopics] = encodeEventTopics({
    abi: swapShellAbi,
    eventName: "SwapExecuted",
    args: { taker, tokenIn, tokenOut },
  });
  const legacyTopic0 = toEventSelector(swapShellLegacyAbi[0]);

  const logs = await publicClient.request({
    method: "eth_getLogs",
    params: [
      {
        address: resolvedSwapShell,
        topics: [[currentTopic0 as Hex, legacyTopic0], ...indexedTopics],
        fromBlock: numberToHex(fromBlock),
        toBlock: typeof toBlock === "bigint" ? numberToHex(toBlock) : toBlock,
      },
    ],
  });

  return decodeSwapExecutedLogs(logs.map((log) => formatLog(log)) as readonly Log[]);
}

export function decodeSwapExecutedLogs(logs: readonly Log[]): DecodedSwapExecutedLog[] {
  const decoded: DecodedSwapExecutedLog[] = [];
  for (const log of logs) {
    try {
      const event = decodeEventLog({
        abi: swapExecutedAbis,
        data: log.data,
        topics: log.topics,
      });
      if (event.eventName !== "SwapExecuted") continue;

      decoded.push({
        address: log.address,
        blockHash: log.blockHash ?? null,
        blockNumber: log.blockNumber ?? null,
        logIndex: log.logIndex ?? null,
        transactionHash: log.transactionHash ?? null,
        transactionIndex: log.transactionIndex ?? null,
        args: event.args as SwapExecutedArgs,
      });
    } catch {
      // Receipts contain logs from every contract touched by the transaction.
      // Ignore logs that do not match SwapShell's event signature.
    }
  }
  return decoded;
}
