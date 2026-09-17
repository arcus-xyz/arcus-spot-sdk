import type { Account, Hex, WalletClient } from "viem";
import type {
  ArcusFirmQuote,
  ArcusSignedQuote,
  Eip712TypedData,
  FirmQuote,
  LifiFirmQuote,
  LifiSignedQuote,
  Permit,
  RialtoFirmQuote,
  RialtoSignedQuote,
  SignedQuote,
  SplitSignature,
  Venue,
  ZeroxFirmQuote,
  ZeroxSignedQuote,
} from "./types.js";
import { getZeroxSigningTasks } from "./venues/zerox.js";

export type QuoteSigningTask = {
  venue: FirmQuote["venue"];
  kind: "approval" | "trade";
  typedData: Eip712TypedData;
};

export type SignQuoteOptions = {
  taker?: Hex;
  account?: Account | Hex;
  /**
   * Optional EIP-2612 permits to fold into SwapShell.permits[] (arcus). Use when
   * the taker's sellToken→Permit2 allowance is missing and they sign a one-time
   * permit instead of an approve() tx
   */
  permits?: Permit[];
  /**
   * Arcus only. Echo the `/quote` `builderFeeBps` onto the submit body so
   * settlement matches the quoted fee plan.
   */
  builderFeeBps?: number;
};

export function getQuoteSigningTasks(quote: FirmQuote): QuoteSigningTask[] {
  if (quote.venue === "zerox") return getZeroxSigningTasks(quote);
  return [{ venue: quote.venue, kind: "trade", typedData: tradeTypedData(quote) }];
}

export async function signQuote(
  quote: FirmQuote,
  walletClient: WalletClient,
  options: SignQuoteOptions = {},
): Promise<SignedQuote> {
  const taker = options.taker ?? inferTaker(quote) ?? walletClient.account?.address;
  if (!taker) {
    throw new Error("Unable to infer taker address; pass signQuote(..., { taker })");
  }

  if (quote.venue === "zerox") {
    return signZeroxQuote(quote, walletClient, taker, options.account);
  }
  if (quote.venue === "arcus") {
    return signArcusQuote(quote, walletClient, taker, options);
  }
  if (quote.venue === "rialto") {
    return signRialtoQuote(quote, walletClient, taker, options);
  }
  if (quote.venue === "lifi") {
    return signLifiQuote(quote, walletClient, taker, options);
  }
  throw new Error(`signQuote does not support venue ${quote.venue}`);
}

export async function signTypedDataWithViem(
  walletClient: WalletClient,
  typedData: Eip712TypedData,
  account?: Account | Hex,
): Promise<Hex> {
  const signingAccount = account ?? walletClient.account ?? undefined;
  return walletClient.signTypedData({
    account: signingAccount,
    domain: typedData.domain,
    types: stripEip712Domain(typedData.types),
    primaryType: typedData.primaryType,
    message: typedData.message,
  } as Parameters<WalletClient["signTypedData"]>[0]);
}

export function splitSignature(signature: Hex): SplitSignature {
  const hex = signature.slice(2);
  if (hex.length !== 130) {
    throw new Error(`Expected 65-byte signature, got ${hex.length / 2} bytes`);
  }

  const rawV = Number.parseInt(hex.slice(128, 130), 16);
  const v = rawV < 27 ? rawV + 27 : rawV;
  if (v !== 27 && v !== 28) {
    throw new Error(`Unsupported ECDSA recovery byte: ${rawV}`);
  }

  return {
    signatureType: 2,
    r: `0x${hex.slice(0, 64)}`,
    s: `0x${hex.slice(64, 128)}`,
    v,
  };
}

async function signZeroxQuote(
  quote: ZeroxFirmQuote,
  walletClient: WalletClient,
  taker: Hex,
  account?: Account | Hex,
): Promise<ZeroxSignedQuote> {
  const signature = await signTypedDataWithViem(walletClient, tradeTypedData(quote), account);

  // EIP-2612 Permit
  const permits = quote.approval
    ? [
        permitFromApproval(
          await signTypedDataWithViem(walletClient, quote.approval.eip712, account),
          quote.approval.eip712,
        ),
      ]
    : undefined;

  return {
    venue: "zerox",
    chainId: typedDataChainId(tradeTypedData(quote)),
    taker,
    typedData: tradeTypedData(quote),
    signature,
    quotedAmountIn: quote.sellAmount,
    quotedAmountOut: quote.buyAmount,
    ...(permits ? { permits } : {}),
  };
}

async function signArcusQuote(
  quote: ArcusFirmQuote,
  walletClient: WalletClient,
  taker: Hex,
  options: SignQuoteOptions,
): Promise<ArcusSignedQuote> {
  const signature = await signTypedDataWithViem(walletClient, quote.toSign, options.account);

  const permits = options.permits?.length ? options.permits : undefined;

  return {
    venue: "arcus",
    chainId: typedDataChainId(quote.toSign),
    taker,
    typedData: quote.toSign,
    signature,
    ...(permits ? { permits } : {}),
    ...(options.builderFeeBps != null ? { builderFeeBps: options.builderFeeBps } : {}),
  };
}

async function signRialtoQuote(
  quote: RialtoFirmQuote,
  walletClient: WalletClient,
  taker: Hex,
  options: SignQuoteOptions,
): Promise<RialtoSignedQuote> {
  const signature = await signTypedDataWithViem(walletClient, quote.toSign, options.account);

  const permits = options.permits?.length ? options.permits : undefined;

  return {
    venue: "rialto",
    chainId: typedDataChainId(quote.toSign),
    taker,
    typedData: quote.toSign,
    signature,
    tx: quote.tx,
    quotedAmountIn: quote.sellAmount,
    quotedAmountOut: quote.buyAmount,
    ...(permits ? { permits } : {}),
  };
}

async function signLifiQuote(
  quote: LifiFirmQuote,
  walletClient: WalletClient,
  taker: Hex,
  options: SignQuoteOptions,
): Promise<LifiSignedQuote> {
  const signature = await signTypedDataWithViem(walletClient, quote.toSign, options.account);

  const permits = options.permits?.length ? options.permits : undefined;

  return {
    venue: "lifi",
    chainId: typedDataChainId(quote.toSign),
    taker,
    typedData: quote.toSign,
    signature,
    tx: quote.tx,
    raw: quote.raw,
    minBuyAmount: quote.minBuyAmount,
    quotedAmountIn: quote.sellAmount,
    quotedAmountOut: quote.buyAmount,
    ...(permits ? { permits } : {}),
  };
}

/**
 * Convert an EIP-2612 approval signature + its typed data into a Permit
 * entry suitable for SwapShell.permits[]. Reads token / value / deadline
 * from the same typed data the user just signed, so the on-chain call can
 * recover the same digest.
 */
function permitFromApproval(signature: Hex, typedData: Eip712TypedData): Permit {
  const hex = signature.slice(2);
  if (hex.length !== 130) {
    throw new Error(`Expected 65-byte signature, got ${hex.length / 2} bytes`);
  }
  const rawV = Number.parseInt(hex.slice(128, 130), 16);
  const v = rawV < 27 ? rawV + 27 : rawV;
  if (v !== 27 && v !== 28) {
    throw new Error(`Unsupported ECDSA recovery byte: ${rawV}`);
  }

  const token = typedData.domain.verifyingContract;
  const value = typedData.message.value;
  const deadline = typedData.message.deadline;
  if (typeof token !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(token)) {
    throw new Error("EIP-2612 approval missing verifyingContract (token address)");
  }
  if (value == null || deadline == null) {
    throw new Error("EIP-2612 approval message missing value/deadline");
  }

  return {
    token: token as Hex,
    value: String(value),
    deadline: String(deadline),
    v,
    r: `0x${hex.slice(0, 64)}`,
    s: `0x${hex.slice(64, 128)}`,
  };
}

function stripEip712Domain(types: Eip712TypedData["types"]): Eip712TypedData["types"] {
  const { EIP712Domain: _domain, ...rest } = types;
  return rest;
}

function inferTaker(quote: FirmQuote): Hex | undefined {
  if (quote.venue === "arcus") {
    const witnessTaker = nestedValue(quote.toSign.message, ["witness", "taker"]);
    return isHexAddress(witnessTaker) ? witnessTaker : undefined;
  }
  if (quote.venue === "rialto") {
    // RialtoSwap witness recipient is the taker (funds land there).
    const recipient = quote.toSign.message.witness.recipient;
    return isHexAddress(recipient) ? recipient : undefined;
  }

  const approvalOwner = quote.venue === "zerox" ? quote.approval?.eip712.message.owner : undefined;
  if (isHexAddress(approvalOwner)) return approvalOwner;

  const typedData = maybeTradeTypedData(quote);
  const tradeOwner = typedData?.message.owner;
  if (isHexAddress(tradeOwner)) return tradeOwner;

  if (!typedData) return undefined;
  const recipient = nestedValue(typedData.message, ["slippageAndActions", "recipient"]);
  return isHexAddress(recipient) ? recipient : undefined;
}

function tradeTypedData(quote: FirmQuote): Eip712TypedData {
  const typedData = maybeTradeTypedData(quote);
  if (!typedData) {
    throw new Error(`Quote is missing trade typed data for venue ${quote.venue}`);
  }
  return typedData;
}

function maybeTradeTypedData(quote: FirmQuote): Eip712TypedData | undefined {
  return quote.venue === "zerox" ? (quote.toSign ?? quote.trade?.eip712) : quote.toSign;
}

function typedDataChainId(typedData: Eip712TypedData): number {
  const chainId = typedData.domain.chainId;
  if (typeof chainId === "number") return chainId;
  if (typeof chainId === "bigint") return Number(chainId);
  if (typeof chainId === "string") return Number(chainId);
  throw new Error("Typed data is missing domain.chainId");
}

function nestedValue(source: Record<string, unknown>, path: string[]): unknown {
  let current: unknown = source;
  for (const key of path) {
    if (!current || typeof current !== "object" || !(key in current)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function isHexAddress(value: unknown): value is Hex {
  return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);
}
