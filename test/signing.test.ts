import { describe, expect, test } from "bun:test";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrum } from "viem/chains";
import {
  getQuoteSigningTasks,
  signQuote,
  splitSignature,
  type Eip712TypedData,
  type FirmQuote,
  type RialtoFirmQuote,
  type RialtoTypedData,
  type ZeroxFirmQuote,
} from "../src";

const typedData: Eip712TypedData = {
  domain: {
    name: "Permit2",
    chainId: 42161,
    verifyingContract: "0x000000000022d473030f116ddee9f6b43ac78ba3",
  },
  types: {
    EIP712Domain: [
      { name: "name", type: "string" },
      { name: "chainId", type: "uint256" },
      { name: "verifyingContract", type: "address" },
    ],
    PermitWitnessTransferFrom: [{ name: "nonce", type: "uint256" }],
  },
  primaryType: "PermitWitnessTransferFrom",
  message: { nonce: "1" },
};

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

describe("getQuoteSigningTasks", () => {
  test("returns approval and trade tasks for a 0x quote", () => {
    const quote: FirmQuote = {
      venue: "zerox",
      details: { paths: [{ proportionBps: 10_000, hops: [{ protocol: "zerox" }] }] },
      buyAmount: "100",
      sellAmount: "90",
      fees: [],
      approval: { type: "permit", eip712: typedData },
      toSign: typedData,
      raw: {},
    };

    expect(getQuoteSigningTasks(quote).map((task) => task.kind)).toEqual(["approval", "trade"]);
  });
});

describe("signQuote (zerox)", () => {
  // Anvil account 0 — deterministic, no real funds.
  const account = privateKeyToAccount(
    "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  );
  const walletClient = createWalletClient({
    account,
    chain: arbitrum,
    transport: http("https://arb1.arbitrum.io/rpc"),
  });

  const tradeTypedData: Eip712TypedData = {
    domain: {
      name: "Permit2",
      chainId: 42161,
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
        { name: "slippageAndActions", type: "SlippageAndActions" },
      ],
      TokenPermissions: [
        { name: "token", type: "address" },
        { name: "amount", type: "uint256" },
      ],
      SlippageAndActions: [
        { name: "recipient", type: "address" },
        { name: "buyToken", type: "address" },
        { name: "minAmountOut", type: "uint256" },
        { name: "actions", type: "bytes[]" },
      ],
    },
    primaryType: "PermitWitnessTransferFrom",
    message: {
      permitted: {
        token: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
        amount: "1000000",
      },
      spender: "0xfbecf057d93430a15a936dd57a7424d4f0a8772b",
      nonce: "1",
      deadline: "9999999999",
      slippageAndActions: {
        recipient: account.address,
        buyToken: "0x82af49447d8a07e3bd95bd0d56f35241523fbab1",
        minAmountOut: "1",
        actions: [],
      },
    },
  };

  const approvalTypedData: Eip712TypedData = {
    domain: {
      name: "USD Coin",
      version: "2",
      chainId: 42161,
      verifyingContract: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    },
    types: {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" },
      ],
      Permit: [
        { name: "owner", type: "address" },
        { name: "spender", type: "address" },
        { name: "value", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    },
    primaryType: "Permit",
    message: {
      owner: account.address,
      spender: "0x000000000022d473030f116ddee9f6b43ac78ba3",
      value: "115792089237316195423570985008687907853269984665640564039457584007913129639935",
      nonce: "0",
      deadline: "9999999999",
    },
  } as const;

  test("with no approval, returns trade-only shape (no permits[])", async () => {
    const quote: ZeroxFirmQuote = {
      venue: "zerox",
      details: { paths: [{ proportionBps: 10_000, hops: [{ protocol: "zerox" }] }] },
      buyAmount: "100",
      sellAmount: "1000000",
      fees: [],
      toSign: tradeTypedData,
      raw: {},
    };

    const signed = await signQuote(quote, walletClient);

    expect(signed.venue).toBe("zerox");
    if (signed.venue !== "zerox") throw new Error("unreachable");
    expect(signed.chainId).toBe(42161);
    expect(signed.taker).toBe(account.address);
    expect(signed.signature).toMatch(/^0x[0-9a-fA-F]{130}$/);
    expect(signed.typedData).toBe(tradeTypedData);
    expect(signed.quotedAmountIn).toBe("1000000");
    expect(signed.quotedAmountOut).toBe("100");
    expect(signed.permits).toBeUndefined();
  });

  test("with approval, folds it into permits[] with v/r/s + token/value/deadline", async () => {
    const quote: ZeroxFirmQuote = {
      venue: "zerox",
      details: { paths: [{ proportionBps: 10_000, hops: [{ protocol: "zerox" }] }] },
      buyAmount: "100",
      sellAmount: "1000000",
      fees: [],
      approval: { type: "permit", eip712: approvalTypedData },
      toSign: tradeTypedData,
      raw: {},
    };

    const signed = await signQuote(quote, walletClient);

    if (signed.venue !== "zerox") throw new Error("unreachable");
    expect(signed.permits).toHaveLength(1);
    const permit = signed.permits![0]!;
    expect(permit.token.toLowerCase()).toBe(
      approvalTypedData.domain.verifyingContract!.toLowerCase(),
    );
    expect(permit.value).toBe(approvalTypedData.message.value);
    expect(permit.deadline).toBe(approvalTypedData.message.deadline);
    expect([27, 28]).toContain(permit.v);
    expect(permit.r).toMatch(/^0x[0-9a-fA-F]{64}$/);
    expect(permit.s).toMatch(/^0x[0-9a-fA-F]{64}$/);
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
        diamondCalldataHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
    },
  };

  test("returns lifi submit shape with tx, raw, and minBuyAmount", async () => {
    const quote = {
      venue: "lifi",
      details: { paths: [{ proportionBps: 10_000, hops: [{ protocol: "lifi" }] }] },
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

describe("signQuote (rialto)", () => {
  const account = privateKeyToAccount(
    "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  );
  const walletClient = createWalletClient({
    account,
    chain: arbitrum,
    transport: http("https://arb1.arbitrum.io/rpc"),
  });

  const rialtoTypedData: RialtoTypedData = {
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
        { name: "witness", type: "RialtoSwap" },
      ],
      TokenPermissions: [
        { name: "token", type: "address" },
        { name: "amount", type: "uint256" },
      ],
      RialtoSwap: [
        { name: "recipient", type: "address" },
        { name: "buyToken", type: "address" },
        { name: "minBuyAmount", type: "uint256" },
        { name: "deadline", type: "uint64" },
        { name: "feeRecipient", type: "address" },
        { name: "srcBps", type: "uint16" },
        { name: "dstBps", type: "uint16" },
        { name: "referralCode", type: "bytes32" },
        { name: "quoteId", type: "bytes32" },
        { name: "actionsHash", type: "bytes32" },
      ],
    },
    primaryType: "PermitWitnessTransferFrom",
    message: {
      permitted: {
        token: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
        amount: "1000000",
      },
      spender: "0xc94135b63772b91d79d0a2daab2a8801f32359bd",
      nonce: "1",
      deadline: "9999999999",
      witness: {
        recipient: account.address,
        buyToken: "0x82af49447d8a07e3bd95bd0d56f35241523fbab1",
        minBuyAmount: "198",
        deadline: 9999999999,
        feeRecipient: "0x0000000000000000000000000000000000000000",
        srcBps: 10,
        dstBps: 0,
        referralCode: `0x${"11".repeat(32)}`,
        quoteId: `0x${"22".repeat(32)}`,
        actionsHash: `0x${"aa".repeat(32)}`,
      },
    },
  };

  test("returns rialto submit shape with tx", async () => {
    const quote: RialtoFirmQuote = {
      venue: "rialto",
      details: { paths: [{ proportionBps: 10_000, hops: [{ protocol: "rialto" }] }] },
      buyAmount: "200",
      sellAmount: "1000000",
      minBuyAmount: "198",
      fees: [],
      quoteId: "q1",
      toSign: rialtoTypedData,
      tx: {
        to: "0xc94135b63772b91d79d0a2daab2a8801f32359bd",
        data: "0x1234",
        value: "0",
        signatureOffset: 100,
        estimatedGas: 300000,
      },
      raw: {
        quote_id: "q1",
        settlement: "permit2",
        platform_fee: { total_bps: 10 },
      },
    };

    const signed = await signQuote(quote, walletClient, { taker: account.address });

    expect(signed.venue).toBe("rialto");
    if (signed.venue !== "rialto") throw new Error("unreachable");
    expect(signed.chainId).toBe(4663);
    expect(signed.taker).toBe(account.address);
    expect(signed.signature).toMatch(/^0x[0-9a-fA-F]{130}$/);
    expect(signed.tx).toEqual(quote.tx);
    expect(signed.typedData.message.witness.buyToken).toBe(
      "0x82af49447d8a07e3bd95bd0d56f35241523fbab1",
    );
    expect(signed.quotedAmountIn).toBe("1000000");
    expect(signed.quotedAmountOut).toBe("200");
  });
});
