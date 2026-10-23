import { describe, expect, test } from "bun:test";
import {
  encodeAbiParameters,
  encodeEventTopics,
  parseAbiItem,
  toEventSelector,
  type Address,
  type Hex,
  type Log,
} from "viem";
import { decodeSwapExecutedLogs, swapShellLegacyAbi } from "../src";

describe("decodeSwapExecutedLogs", () => {
  test("decodes quoted amount fields from legacy SwapExecuted logs", () => {
    const shell = "0x0000000000000000000000000000000000000001";
    const taker = "0x0000000000000000000000000000000000000002";
    const tokenIn = "0x0000000000000000000000000000000000000003";
    const tokenOut = "0x0000000000000000000000000000000000000004";
    const router = "0x0000000000000000000000000000000000000005";
    const routeTag = `0x${"00".repeat(32)}` as Hex;

    const topics = encodeEventTopics({
      abi: swapShellLegacyAbi,
      eventName: "SwapExecuted",
      args: { taker, tokenIn, tokenOut },
    });
    const data = encodeAbiParameters(
      [
        { type: "uint256" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "address" },
        { type: "bytes32" },
        { type: "bool" },
        { type: "string" },
      ],
      [98n, 100n, 100n, 123n, 120n, 1n, 2n, router, routeTag, true, ""],
    );

    const decoded = decodeSwapExecutedLogs([
      {
        address: shell as Address,
        data,
        topics,
        blockHash: null,
        blockNumber: null,
        logIndex: 0,
        transactionHash: null,
        transactionIndex: null,
      } as Log,
    ]);

    expect(decoded).toHaveLength(1);
    expect(decoded[0]?.args.taker.toLowerCase()).toBe(taker);
    expect(decoded[0]?.args.quotedAmountIn).toBe(100n);
    expect(decoded[0]?.args.quotedAmountOut).toBe(123n);
    expect(decoded[0]?.args.amountOut).toBe(120n);
    expect(decoded[0]?.args.apiKeyId).toBeUndefined();
  });
});

describe("decodeSwapExecutedLogs (deployed SwapShell event)", () => {
  // Robinhood mainnet and testnet SwapShell implementations emit SwapExecuted
  // with a `string apiKeyId` between `routeTag` and `success`.
  const deployedEvent = parseAbiItem(
    "event SwapExecuted(address indexed taker, address indexed tokenIn, address indexed tokenOut, uint256 minAmountOut, uint256 amountIn, uint256 quotedAmountIn, uint256 quotedAmountOut, uint256 amountOut, uint256 tokenInBenchmarkPrice, uint256 tokenOutBenchmarkPrice, address router, bytes32 routeTag, string apiKeyId, bool success, string reason)",
  );

  test("topic0 matches the deployed event", () => {
    expect(toEventSelector(deployedEvent)).toBe(
      "0x824a7dbfc9f746ced98e93f691f8e5c68d0a549b6999eeaa16192f903e39aa27",
    );
  });

  test("decodes a log carrying apiKeyId", () => {
    const taker = "0x0000000000000000000000000000000000000002";
    const router = "0x0000000000000000000000000000000000000005";
    const topics = encodeEventTopics({
      abi: [deployedEvent],
      eventName: "SwapExecuted",
      args: {
        taker,
        tokenIn: "0x0000000000000000000000000000000000000003",
        tokenOut: "0x0000000000000000000000000000000000000004",
      },
    });
    const data = encodeAbiParameters(
      deployedEvent.inputs.filter((input) => !input.indexed),
      [98n, 100n, 100n, 123n, 120n, 1n, 2n, router, `0x${"00".repeat(32)}`, "anonymous", true, ""],
    );

    const decoded = decodeSwapExecutedLogs([
      {
        address: "0x0000000000000000000000000000000000000001",
        data,
        topics,
        blockHash: null,
        blockNumber: null,
        logIndex: 0,
        transactionHash: null,
        transactionIndex: null,
      } as unknown as Log,
    ]);

    expect(decoded).toHaveLength(1);
    expect(decoded[0]?.args.taker.toLowerCase()).toBe(taker);
    expect(decoded[0]?.args.amountOut).toBe(120n);
    expect(decoded[0]?.args.apiKeyId).toBe("anonymous");
    expect(decoded[0]?.args.success).toBe(true);
  });
});
