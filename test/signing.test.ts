import { describe, expect, test } from "bun:test";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrum } from "viem/chains";
import {
  signQuote,
  splitSignature,
  type BebopFirmQuote,
  type Eip712TypedData,
} from "../src";

const BEBOP_ROUTER = "0xBeb0009ACa35087ce7cCF11637E24dd1Aad3bf2A" as const;
const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3" as const;

describe("splitSignature", () => {
  test("pads and normalizes a 0/1 recovery byte to 27/28", () => {
    const r = "11".repeat(32);
    const s = "22".repeat(32);
    expect(splitSignature(`0x${r}${s}01`)).toEqual({
      signatureType: 2,
      r: `0x${r}`,
      s: `0x${s}`,
      v: 28,
    });
  });
});

describe("signQuote (lifi)", () => {
  const account = privateKeyToAccount(
    "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  );
  const walletClient = createWalletClient({
    account,
    chain: arbitrum,
    transport: http("https://arb1.arbitrum.io/rpc"),
  });

  const lifiTypedData: Eip712TypedData = {
    domain: {
      name: "Permit2",
      chainId: 4663,
      verifyingContract: "0x000000000022d473030f116ddee9f6b43ac78ba3",
    },
    types: {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" },
      ],
      PermitWitnessTransferFrom: [
        { name: "permitted", type: "TokenPermissions" },
        { name: "spender", type: "address" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
        { name: "witness", type: "LiFiCall" },
      ],
      TokenPermissions: [
        { name: "token", type: "address" },
        { name: "amount", type: "uint256" },
      ],
      LiFiCall: [
        { name: "diamondAddress", type: "address" },
        { name: "diamondCalldataHash", type: "bytes32" },
      ],
    },
    primaryType: "PermitWitnessTransferFrom",
    message: {
      permitted: {
        token: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
        amount: "1000000",
      },
      spender: "0x8eABB4E117fB70b346592e013855f6d825F50af1",
      nonce: "0",
      deadline: "9999999999",
      witness: {
        diamondAddress: "0xB477751B76CF82d00a686A1232f5fCD772414Af3",
        diamondCalldataHash:
          "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
    },
  };

  test("returns lifi submit shape with tx, raw, and minBuyAmount", async () => {
    const quote = {
      venue: "lifi",
      buyAmount: "200",
      sellAmount: "1000000",
      minBuyAmount: "198",
      fees: [],
      quoteId: "q1",
      toSign: lifiTypedData,
      tx: {
        permit2Proxy: "0x8eABB4E117fB70b346592e013855f6d825F50af1",
        diamondCalldata: "0x1234",
        buyToken: "0x82af49447d8a07e3bd95bd0d56f35241523fbab1",
        value: "0",
      },
      raw: {
        action: { toToken: { address: "0x82af49447d8a07e3bd95bd0d56f35241523fbab1" } },
        estimate: { toAmountMin: "198" },
      },
    } as const;

    const signed = await signQuote(quote, walletClient, { taker: account.address });

    expect(signed.venue).toBe("lifi");
    if (signed.venue !== "lifi") throw new Error("unreachable");
    expect(signed.chainId).toBe(4663);
    expect(signed.taker).toBe(account.address);
    expect(signed.signature).toMatch(/^0x[0-9a-fA-F]{130}$/);
    expect(signed.tx).toEqual(quote.tx);
    expect(signed.raw).toEqual(quote.raw);
    expect(signed.minBuyAmount).toBe("198");
    expect(signed.quotedAmountIn).toBe("1000000");
    expect(signed.quotedAmountOut).toBe("200");
  });
});

describe("signQuote (bebop)", () => {
  const account = privateKeyToAccount(
    "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  );
  const walletClient = createWalletClient({ account, transport: http("http://localhost") });
  const sellToken = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" as const;
  const buyToken = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73" as const;

  const quote: BebopFirmQuote = {
    venue: "bebop",
    buyAmount: "400",
    sellAmount: "1000000",
    minBuyAmount: "390",
    fees: [],
    quoteId: "q1",
    expiry: 9_999_999_999,
    toSign: {
      domain: { name: "Permit2", chainId: 4663, verifyingContract: PERMIT2 },
      types: {
        PermitWitnessTransferFrom: [
          { name: "permitted", type: "TokenPermissions" },
          { name: "spender", type: "address" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" },
          { name: "witness", type: "BebopRouterOrder" },
        ],
        TokenPermissions: [
          { name: "token", type: "address" },
          { name: "amount", type: "uint256" },
        ],
        BebopRouterOrder: [
          { name: "fromAmount", type: "uint256" },
          { name: "toAmount", type: "uint256" },
          { name: "limitAmount", type: "int256" },
          { name: "fromToken", type: "address" },
          { name: "toToken", type: "address" },
          { name: "pmmFromToken", type: "address" },
          { name: "pmmToToken", type: "address" },
          { name: "tokensOwner", type: "address" },
          { name: "receiver", type: "address" },
          { name: "originAddress", type: "address" },
          { name: "oracle", type: "address" },
          { name: "checker", type: "address" },
          { name: "info", type: "uint256" },
          { name: "routerNonce", type: "uint256" },
          { name: "extraInfoHash", type: "bytes32" },
          { name: "hooksHash", type: "bytes32" },
        ],
      },
      primaryType: "PermitWitnessTransferFrom",
      message: {
        permitted: { token: sellToken, amount: "1000000" },
        spender: BEBOP_ROUTER,
        nonce: "9",
        deadline: "9999999999",
        witness: {
          fromAmount: "1000000",
          toAmount: "400",
          limitAmount: "390",
          fromToken: sellToken,
          toToken: buyToken,
          pmmFromToken: sellToken,
          pmmToToken: buyToken,
          tokensOwner: account.address,
          receiver: account.address,
          originAddress: "0x0000000000000000000000000000000000000000",
          oracle: "0x0000000000000000000000000000000000000000",
          checker: "0x0000000000000000000000000000000000000000",
          info: "1",
          routerNonce: "9",
          extraInfoHash: `0x${"00".repeat(32)}`,
          hooksHash: `0x${"00".repeat(32)}`,
        },
      },
    },
    tx: {
      to: BEBOP_ROUTER,
      data: "0x1234",
      value: "0",
      originAddress: "0x0000000000000000000000000000000000000000",
    },
    raw: {} as never,
  };

  test("signs Permit2 data, infers tokensOwner, and echoes the prepared tx", async () => {
    const signed = await signQuote(quote, walletClient);
    expect(signed.venue).toBe("bebop");
    if (signed.venue !== "bebop") throw new Error("unreachable");
    expect(signed.chainId).toBe(4663);
    expect(signed.taker).toBe(account.address);
    expect(signed.typedData).toBe(quote.toSign);
    expect(signed.tx).toBe(quote.tx);
    expect(signed.signature).toMatch(/^0x[0-9a-fA-F]{130}$/);
  });
});
