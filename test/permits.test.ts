import { describe, expect, test } from "bun:test";
import { BaseError } from "viem";
import {
  buildLifiSellTokenPermitIfNeeded,
  PermitUnsupportedError,
  type LifiFirmQuote,
} from "../src";

const TOKEN = "0xD7321801CAae694090694Ff55A9323139F043B88" as const; // JUGGERNAUT (no EIP-2612)
const TAKER = "0x769d89eA8a732f8bb739dc5c06caa27f92BF2df9" as const;

// Minimal lifi quote carrying just what buildLifiSellTokenPermitIfNeeded reads.
function lifiQuote(): LifiFirmQuote {
  return {
    toSign: {
      domain: { chainId: 4663 },
      message: { permitted: { token: TOKEN, amount: "1000000000000000000" } },
    },
  } as unknown as LifiFirmQuote;
}

// A publicClient stub: allowance is below sellAmount (so a permit is needed),
// and the nonces() read throws `noncesError`.
function stubClient(noncesError?: unknown, versionError?: unknown) {
  return {
    readContract: async ({ functionName }: { functionName: string }) => {
      if (functionName === "allowance") return 0n;
      if (functionName === "nonces" && noncesError !== undefined) throw noncesError;
      if (functionName === "nonces") return 0n;
      if (functionName === "name") return "The Juggernaut";
      if (functionName === "version" && versionError !== undefined) throw versionError;
      if (functionName === "version") return "1";
      throw new Error(`unexpected read: ${functionName}`);
    },
  } as never;
}

// viem wraps a revert as ContractFunctionExecutionError; some RPCs (Robinhood
// mainnet) intermittently omit the typed revert cause, leaving only a bare
// RpcRequestError with JSON-RPC code 3 / details "execution reverted".
function degradedRevertError(): BaseError {
  const error = new BaseError('The contract function "nonces" reverted.');
  error.cause = {
    name: "CallExecutionError",
    details: "execution reverted",
    cause: { name: "RpcRequestError", code: 3, data: "0x", details: "execution reverted" },
  } as never;
  return error;
}

function rateLimitError(): BaseError {
  const error = new BaseError("RPC Request failed.");
  error.cause = {
    name: "CallExecutionError",
    details: "Too Many Requests",
    cause: { name: "RpcRequestError", code: 429, details: "Too Many Requests" },
  } as never;
  return error;
}

describe("buildLifiSellTokenPermitIfNeeded — non-EIP-2612 detection", () => {
  test("throws PermitUnsupportedError when nonces() reverts with the degraded RPC shape", async () => {
    const walletClient = {} as never;
    await expect(
      buildLifiSellTokenPermitIfNeeded({
        quote: lifiQuote(),
        publicClient: stubClient(degradedRevertError()),
        walletClient,
        taker: TAKER,
      }),
    ).rejects.toBeInstanceOf(PermitUnsupportedError);
  });

  test("rethrows the raw error for transient nonces() transport failures (429)", async () => {
    const walletClient = {} as never;
    const promise = buildLifiSellTokenPermitIfNeeded({
      quote: lifiQuote(),
      publicClient: stubClient(rateLimitError()),
      walletClient,
      taker: TAKER,
    });
    await expect(promise).rejects.not.toBeInstanceOf(PermitUnsupportedError);
    await expect(promise).rejects.toBeInstanceOf(BaseError);
  });

  test("rethrows the raw error for transient version() transport failures (429)", async () => {
    const walletClient = {} as never;
    const promise = buildLifiSellTokenPermitIfNeeded({
      quote: lifiQuote(),
      publicClient: stubClient(undefined, rateLimitError()),
      walletClient,
      taker: TAKER,
    });
    await expect(promise).rejects.not.toBeInstanceOf(PermitUnsupportedError);
    await expect(promise).rejects.toBeInstanceOf(BaseError);
  });
});
