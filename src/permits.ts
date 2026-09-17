import {
  BaseError,
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
  ExecutionRevertedError,
  encodeAbiParameters,
  keccak256,
  toBytes,
  type Account,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { PERMIT2_ADDRESS } from "./constants.js";
import { signTypedDataWithViem, splitSignature } from "./signing.js";
import type {
  ArcusFirmQuote,
  Eip712TypedData,
  LifiFirmQuote,
  Permit,
  RialtoFirmQuote,
} from "./types.js";

/** Default permit/approve amount: unlimited, so the taker never re-authorizes the token. */
export const MAX_UINT256 = (1n << 256n) - 1n;

// Minimal ERC-20 + EIP-2612 reads needed to build a token→Permit2 permit.
const erc20PermitAbi = [
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "name",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "string" }],
  },
  {
    type: "function",
    name: "nonces",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "DOMAIN_SEPARATOR",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "bytes32" }],
  },
] as const;

// EIP-5267: the domain the token actually uses to verify permits. Prefer this
// over `version()`, which some tokens (e.g. CircusQuoteTokenV3) expose as a
// metadata tag that is not the EIP-712 domain version.
const eip712DomainAbi = [
  {
    type: "function",
    name: "eip712Domain",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "fields", type: "bytes1" },
      { name: "name", type: "string" },
      { name: "version", type: "string" },
      { name: "chainId", type: "uint256" },
      { name: "verifyingContract", type: "address" },
      { name: "salt", type: "bytes32" },
      { name: "extensions", type: "uint256[]" },
    ],
  },
] as const;

const versionAbi = [
  {
    type: "function",
    name: "version",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "string" }],
  },
] as const;

const EIP712_DOMAIN_TYPEHASH = keccak256(
  toBytes("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
);

function eip2612DomainSeparator(
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

/** Minimal ERC-20 approve ABI for the non-EIP-2612 fallback tx. */
export const erc20ApproveAbi = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
] as const;

const EIP2612_PERMIT_TYPES = {
  Permit: [
    { name: "owner", type: "address" },
    { name: "spender", type: "address" },
    { name: "value", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

/**
 * Thrown when the sell token has no EIP-2612 `permit()` and the taker's Permit2
 * allowance is insufficient. Recover by sending a one-time on-chain
 * `approve(spender, amount)` on `token` (use {@link erc20ApproveAbi} /
 * {@link MAX_UINT256}), waiting for the receipt, then retrying the builder —
 * the allowance check then passes and it returns `undefined`. `currentAllowance`
 * is exposed because USDT-style tokens revert on nonzero→nonzero approves
 * (send approve(0) first when it's nonzero).
 */
export class PermitUnsupportedError extends Error {
  constructor(
    /** Sell token that can't permit. */
    readonly token: Address,
    /** Approve target — always the canonical Permit2, never a venue router. */
    readonly spender: Address,
    /** Minimum allowance the swap needs. */
    readonly sellAmount: bigint,
    /** The taker's current token→Permit2 allowance. */
    readonly currentAllowance: bigint,
  ) {
    super(
      `Token ${token} has no working EIP-2612 permit; send a one-time ` +
        `approve(${spender}) tx for at least ${sellAmount}, then retry`,
    );
    this.name = "PermitUnsupportedError";
  }
}

// JSON-RPC error code for "execution reverted" (viem's ExecutionRevertedError.code).
const EXECUTION_REVERTED_RPC_CODE = 3;

// Distinguish "token has no EIP-2612 nonces()" (call reverted / returned no data)
// from transient transport failures. Only contract-shaped failures may downgrade
// the flow to a gas-costing approve tx; anything else (HTTP error, timeout, rate
// limit) is not evidence of anything and rethrows.
//
// The typed viem classes are the happy path, but they aren't reliable on their
// own: some RPCs (observed intermittently on Robinhood mainnet) return the revert
// as a bare `{ code: 3, message: "execution reverted", data: "0x" }`, which viem
// wraps only as `ContractFunctionExecutionError -> CallExecutionError ->
// RpcRequestError` with no typed revert cause attached. Matching by class alone
// then misses it, the raw error escapes instead of PermitUnsupportedError, and the
// one-time approve fallback never fires. So also match by error name (survives
// duplicate-viem `instanceof` hazards), by the execution-reverted RPC code (3), and
// by the "execution reverted" text. All three are specific to reverts — transport
// failures (e.g. 429 "Too Many Requests", timeouts) match none and still rethrow.
function isRevertedNode(cause: unknown): boolean {
  if (
    cause instanceof ContractFunctionZeroDataError ||
    cause instanceof ContractFunctionRevertedError ||
    cause instanceof ExecutionRevertedError
  ) {
    return true;
  }
  const node = cause as { name?: unknown; code?: unknown; details?: unknown } | null;
  const name = node?.name;
  if (
    name === "ContractFunctionRevertedError" ||
    name === "ExecutionRevertedError" ||
    name === "ContractFunctionZeroDataError"
  ) {
    return true;
  }
  if (node?.code === EXECUTION_REVERTED_RPC_CODE) return true;
  return (
    typeof node?.details === "string" && node.details.toLowerCase().includes("execution reverted")
  );
}

function isMissingPermitFunction(error: unknown): boolean {
  if (!(error instanceof BaseError)) return false;
  return error.walk(isRevertedNode) !== null;
}

export type BuildArcusPermitOptions = {
  quote: ArcusFirmQuote;
  /** Read-only client for allowance / name / nonces. */
  publicClient: PublicClient;
  /** Wallet that signs the EIP-2612 permit (must be the taker / token owner). */
  walletClient: WalletClient;
  /** Token owner; defaults to the taker bound in the signed order witness. */
  taker?: Hex;
  /** Override the signing account (defaults to walletClient.account). */
  account?: Account | Hex;
  /** Permit value. Default: unlimited, so the taker never re-permits this token. */
  value?: bigint;
  deadline?: bigint;
};

/**
 * Build an EIP-2612 permit for the arcus sellToken→Permit2 allowance, but only
 * when it's actually needed. Returns `undefined` if the taker has already
 * approved Permit2 for at least `sellAmount` (no signature prompt in that case).
 * Throws {@link PermitUnsupportedError} when the token has no EIP-2612 permit —
 * the taker must then send the one-time approve tx it describes.
 */
export async function buildArcusSellTokenPermitIfNeeded(
  options: BuildArcusPermitOptions,
): Promise<Permit | undefined> {
  const witness = options.quote.toSign.message.witness;
  return buildSellTokenPermitIfNeeded({
    token: witness.takerSellToken as Address,
    owner: (options.taker ?? witness.taker) as Address,
    sellAmount: BigInt(witness.sellAmount),
    chainId: Number(options.quote.toSign.domain.chainId),
    publicClient: options.publicClient,
    walletClient: options.walletClient,
    account: options.account,
    value: options.value,
    deadline: options.deadline,
  });
}

// Resolve the EIP-712 name+version the token will use in permit().
//
// `version()` is not authoritative: USDC-style tokens use it as the domain
// version ("2"), but CircusQuoteTokenV3 returns "v3" as a launch-token
// generation tag while its DOMAIN_SEPARATOR is hashed with "1". Signing the
// wrong version recovers a different address and the token reverts
// ERC2612InvalidSigner. Prefer EIP-5267 `eip712Domain()`, then keep a
// `version()` / "1" / "2" candidate only when it matches DOMAIN_SEPARATOR().
async function readEip2612Domain(
  publicClient: PublicClient,
  token: Address,
  chainId: number,
): Promise<{ name: string; version: string }> {
  try {
    const domain = await publicClient.readContract({
      address: token,
      abi: eip712DomainAbi,
      functionName: "eip712Domain",
    });
    const name = domain[1];
    const version = domain[2];
    if (name && version) {
      return { name, version };
    }
  } catch {
    // Token has no EIP-5267 eip712Domain(); fall through.
  }

  const name = await publicClient.readContract({
    address: token,
    abi: erc20PermitAbi,
    functionName: "name",
  });

  let versionFn: string | undefined;
  try {
    versionFn = await publicClient.readContract({
      address: token,
      abi: versionAbi,
      functionName: "version",
    });
  } catch {
    versionFn = undefined;
  }

  try {
    const onchain = await publicClient.readContract({
      address: token,
      abi: erc20PermitAbi,
      functionName: "DOMAIN_SEPARATOR",
    });
    const candidates = [versionFn, "1", "2"].filter(
      (value, index, all): value is string =>
        typeof value === "string" && value.length > 0 && all.indexOf(value) === index,
    );
    for (const version of candidates) {
      const computed = eip2612DomainSeparator(name, version, chainId, token);
      if (computed.toLowerCase() === onchain.toLowerCase()) {
        return { name, version };
      }
    }
  } catch {
    // Token has no DOMAIN_SEPARATOR(); fall through to the heuristic.
  }

  return { name, version: versionFn ?? "1" };
}

type SellTokenPermitCore = {
  token: Address;
  owner: Address;
  sellAmount: bigint;
  chainId: number;
  publicClient: PublicClient;
  walletClient: WalletClient;
  // Explicit `| undefined` so the thin wrappers can forward their own optionals
  // under exactOptionalPropertyTypes.
  account?: Account | Hex | undefined;
  value?: bigint | undefined;
  deadline?: bigint | undefined;
};

// Shared core for arcus + rialto: builds and signs the EIP-2612 sellToken→Permit2
// permit, but only when the taker's Permit2 allowance doesn't already cover
// `sellAmount` (returns undefined otherwise — no signature prompt)
async function buildSellTokenPermitIfNeeded(
  core: SellTokenPermitCore,
): Promise<Permit | undefined> {
  const { token, owner, sellAmount, chainId, publicClient, walletClient } = core;

  const allowance = await publicClient.readContract({
    address: token,
    abi: erc20PermitAbi,
    functionName: "allowance",
    args: [owner, PERMIT2_ADDRESS],
  });
  if (allowance >= sellAmount) return undefined;

  // Probe nonces() before the other reads: its absence means the token isn't
  // EIP-2612 and the taker needs a plain on-chain approve instead.
  let nonce: bigint;
  try {
    nonce = await publicClient.readContract({
      address: token,
      abi: erc20PermitAbi,
      functionName: "nonces",
      args: [owner],
    });
  } catch (error) {
    if (isMissingPermitFunction(error)) {
      throw new PermitUnsupportedError(token, PERMIT2_ADDRESS, sellAmount, allowance);
    }
    throw error;
  }

  const value = core.value ?? MAX_UINT256;
  const deadline = core.deadline ?? BigInt(Math.floor(Date.now() / 1000) + 30 * 60);

  const { name, version } = await readEip2612Domain(publicClient, token, chainId);

  const typedData: Eip712TypedData = {
    domain: { name, version, chainId, verifyingContract: token },
    types: EIP2612_PERMIT_TYPES as unknown as Eip712TypedData["types"],
    primaryType: "Permit",
    message: { owner, spender: PERMIT2_ADDRESS, value, nonce, deadline },
  };

  const signature = await signTypedDataWithViem(walletClient, typedData, core.account);
  const { v, r, s } = splitSignature(signature);

  return { token, value: value.toString(), deadline: deadline.toString(), v, r, s };
}

export type BuildRialtoPermitOptions = {
  quote: RialtoFirmQuote;
  /** Read-only client for allowance / name / nonces / EIP-712 domain. */
  publicClient: PublicClient;
  /** Wallet that signs the EIP-2612 permit (must be the taker / token owner). */
  walletClient: WalletClient;
  /** Token owner; defaults to the recipient bound in the signed RialtoSwap witness. */
  taker?: Hex;
  /** Override the signing account (defaults to walletClient.account). */
  account?: Account | Hex;
  /** Permit value. Default: unlimited, so the taker never re-permits this token. */
  value?: bigint;
  deadline?: bigint;
};

/**
 * Build an EIP-2612 permit for the rialto sellToken→Permit2 allowance, but only
 * when needed — returns `undefined` if the taker has already approved Permit2 for
 * at least `sellAmount`, and throws {@link PermitUnsupportedError} for non-EIP-2612
 * tokens. Folding the returned permit into the signed quote makes a first-time
 * taker's swap fully gasless (SwapShell applies it before RialtoRouter pulls
 * funds). Mirrors the arcus builder but reads the token's EIP-712 domain.
 */
export async function buildRialtoSellTokenPermitIfNeeded(
  options: BuildRialtoPermitOptions,
): Promise<Permit | undefined> {
  const message = options.quote.toSign.message;
  const token = message.permitted.token;
  const owner = options.taker ?? message.witness.recipient;
  if (!token || !owner || message.permitted.amount == null) {
    throw new Error("rialto permit: quote.toSign.message missing permitted/owner");
  }
  return buildSellTokenPermitIfNeeded({
    token,
    owner,
    sellAmount: BigInt(message.permitted.amount),
    chainId: Number(options.quote.toSign.domain.chainId),
    publicClient: options.publicClient,
    walletClient: options.walletClient,
    account: options.account,
    value: options.value,
    deadline: options.deadline,
  });
}

export type BuildLifiPermitOptions = {
  quote: LifiFirmQuote;
  publicClient: PublicClient;
  walletClient: WalletClient;
  taker?: Hex;
  account?: Account | Hex;
  value?: bigint;
  deadline?: bigint;
};

/**
 * Build an EIP-2612 permit for the lifi sellToken→Permit2 allowance when needed.
 * Same Permit2 witness shape as rialto, but the witness binds LiFi diamond calldata.
 */
export async function buildLifiSellTokenPermitIfNeeded(
  options: BuildLifiPermitOptions,
): Promise<Permit | undefined> {
  const message = options.quote.toSign.message as {
    permitted?: { token?: string; amount?: string };
  };
  const token = message.permitted?.token as Address | undefined;
  const owner = options.taker as Address | undefined;
  if (!token || !owner || message.permitted?.amount == null) {
    throw new Error("lifi permit: quote.toSign.message missing permitted token/amount or taker");
  }
  return buildSellTokenPermitIfNeeded({
    token,
    owner,
    sellAmount: BigInt(message.permitted.amount),
    chainId: Number(options.quote.toSign.domain.chainId),
    publicClient: options.publicClient,
    walletClient: options.walletClient,
    account: options.account,
    value: options.value,
    deadline: options.deadline,
  });
}
