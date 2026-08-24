import { describe, expect, test } from "bun:test";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrum } from "viem/chains";
import { signQuote, splitSignature, type Eip712TypedData } from "../src";

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

describe("signQuote taker binding", () => {
  const account = privateKeyToAccount(
    "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  );
  const walletClient = createWalletClient({
    account,
    chain: arbitrum,
    transport: http("https://arb1.arbitrum.io/rpc"),
  });
  const quote = {
    venue: "arcus",
    buyAmount: "1",
    sellAmount: "1",
    fees: [],
    expiry: 1,
    toSign: {
      domain: {
        name: "Permit2",
        chainId: 46630,
        verifyingContract: "0x000000000022d473030f116ddee9f6b43ac78ba3",
      },
      types: {
        PermitWitnessTransferFrom: [{ name: "witness", type: "TakerIntent" }],
        TakerIntent: [{ name: "taker", type: "address" }],
      },
      primaryType: "PermitWitnessTransferFrom",
      message: { witness: { taker: account.address } },
    },
    arcus: { minAmountOut: "1" },
  } as const;

  test("rejects a taker override that differs from the signed witness", async () => {
    await expect(
      signQuote(quote, walletClient, {
        taker: "0x0000000000000000000000000000000000000001",
      }),
    ).rejects.toThrow("does not match the address bound in the signed quote");
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
