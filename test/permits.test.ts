import { describe, expect, test } from "bun:test";
import {
  BaseError,
  encodeAbiParameters,
  keccak256,
  toBytes,
  type Address,
  type Hex,
  type TypedDataDomain,
} from "viem";
import {
  buildLifiSellTokenPermitIfNeeded,
  PermitUnsupportedError,
  type LifiFirmQuote,
} from "../src";

const TOKEN = "0xD7321801CAae694090694Ff55A9323139F043B88" as const; // JUGGERNAUT (no EIP-2612)
const TAKER = "0x769d89eA8a732f8bb739dc5c06caa27f92BF2df9" as const;
const CRUDECAT = "0xBD957Cc9f1e94617792F37bC40f2F299e78AcF3e" as const;
const DUMMY_SIG = `0x${"11".repeat(32)}${"22".repeat(32)}1b` as Hex;

const EIP712_DOMAIN_TYPEHASH = keccak256(
  toBytes("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
);

function domainSeparator(
  name: string,
  version: string,
  chainId: number,
  verifyingContract: Address,
): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "uint256" },
        { type: "address" },
      ],
      [
        EIP712_DOMAIN_TYPEHASH,
        keccak256(toBytes(name)),
        keccak256(toBytes(version)),
        BigInt(chainId),
        verifyingContract,
      ],
    ),
  );
}

// Minimal lifi quote carrying just what buildLifiSellTokenPermitIfNeeded reads.
function lifiQuote(token: Address = TOKEN): LifiFirmQuote {
  return {
    toSign: {
      domain: { chainId: 4663 },
      message: { permitted: { token, amount: "1000000000000000000" } },
    },
  } as unknown as LifiFirmQuote;
}

// A publicClient stub: allowance is below sellAmount (so a permit is needed),
// and the nonces() read throws `noncesError`.
function stubClient(noncesError: unknown) {
  return {
    readContract: async ({ functionName }: { functionName: string }) => {
      if (functionName === "allowance") return 0n;
      if (functionName === "nonces") throw noncesError;
      if (functionName === "name") return "The Juggernaut";
      throw new Error(`unexpected read: ${functionName}`);
    },
  } as never;
}

function capturingWallet() {
  const signed: { domain?: TypedDataDomain } = {};
  return {
    signed,
    walletClient: {
      signTypedData: async (args: { domain: TypedDataDomain }) => {
        signed.domain = args.domain;
        return DUMMY_SIG;
      },
    } as never,
  };
}

function permitClient(reads: Record<string, unknown>) {
  return {
    readContract: async ({ functionName }: { functionName: string }) => {
      if (functionName in reads) {
        const value = reads[functionName];
        if (value instanceof Error) throw value;
        return value;
      }
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

  test("rethrows the raw error for transient transport failures (429)", async () => {
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
});

describe("buildLifiSellTokenPermitIfNeeded — EIP-712 domain version", () => {
  test("prefers eip712Domain() over a misleading token.version()", async () => {
    const { signed, walletClient } = capturingWallet();
    await buildLifiSellTokenPermitIfNeeded({
      quote: lifiQuote(CRUDECAT),
      publicClient: permitClient({
        allowance: 0n,
        nonces: 0n,
        eip712Domain: [
          "0x0f",
          "Crude Cat",
          "1",
          4663n,
          CRUDECAT,
          "0x0000000000000000000000000000000000000000000000000000000000000000",
          [],
        ],
        version: "v3",
      }),
      walletClient,
      taker: TAKER,
    });
    expect(signed.domain?.version).toBe("1");
    expect(signed.domain?.name).toBe("Crude Cat");
  });

  test("keeps version() when it matches DOMAIN_SEPARATOR (USDC-style)", async () => {
    const { signed, walletClient } = capturingWallet();
    await buildLifiSellTokenPermitIfNeeded({
      quote: lifiQuote(CRUDECAT),
      publicClient: permitClient({
        allowance: 0n,
        nonces: 0n,
        eip712Domain: new Error("no eip712Domain"),
        name: "USD Coin",
        version: "2",
        DOMAIN_SEPARATOR: domainSeparator("USD Coin", "2", 4663, CRUDECAT),
      }),
      walletClient,
      taker: TAKER,
    });
    expect(signed.domain?.version).toBe("2");
  });

  test("ignores a metadata version() that does not match DOMAIN_SEPARATOR", async () => {
    const { signed, walletClient } = capturingWallet();
    await buildLifiSellTokenPermitIfNeeded({
      quote: lifiQuote(CRUDECAT),
      publicClient: permitClient({
        allowance: 0n,
        nonces: 0n,
        eip712Domain: new Error("no eip712Domain"),
        name: "Crude Cat",
        version: "v3",
        DOMAIN_SEPARATOR: domainSeparator("Crude Cat", "1", 4663, CRUDECAT),
      }),
      walletClient,
      taker: TAKER,
    });
    expect(signed.domain?.version).toBe("1");
  });
});
