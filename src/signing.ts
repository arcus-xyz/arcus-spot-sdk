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
} from "./types.js";

export type QuoteSigningTask = {
  venue: FirmQuote["venue"];
  kind: "approval" | "trade";
  typedData: Eip712TypedData;
};

export type SignQuoteOptions = {
  /**
   * Optional taker override. When the quote binds a taker/owner in its signed
   * typed data, this value must match that address.
   */
  taker?: Hex;

  account?: Account | Hex;
  /**
   * Optional EIP-2612 permits to fold into SwapShell.permits[] (arcus). Use when
   * the taker's sellToken→Permit2 allowance is missing and they sign a one-time
   * permit instead of an approve() tx
   */
  permits?: Permit[];
};

export function getQuoteSigningTasks(quote: FirmQuote): QuoteSigningTask[] {
  return [{ venue: quote.venue, kind: "trade", typedData: tradeTypedData(quote) }];
}

export async function signQuote(
  quote: FirmQuote,
  walletClient: WalletClient,
  options: SignQuoteOptions = {},
): Promise<SignedQuote> {
  const boundTaker = inferTaker(quote);
  if (options.taker && boundTaker && !sameAddress(options.taker, boundTaker)) {
    throw new Error(
      `Taker override ${options.taker} does not match the address bound in the signed quote ${boundTaker}`,
    );
  }

  const taker = options.taker ?? boundTaker ?? walletClient.account?.address;
  if (!taker) {
    throw new Error("Unable to infer taker address; pass signQuote(..., { taker })");
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
    const recipient = nestedValue(quote.toSign.message, ["witness", "recipient"]);
    return isHexAddress(recipient) ? recipient : undefined;
  }

  const typedData = maybeTradeTypedData(quote);
  const tradeOwner = typedData?.message.owner;
  return isHexAddress(tradeOwner) ? tradeOwner : undefined;
}

function tradeTypedData(quote: FirmQuote): Eip712TypedData {
  const typedData = maybeTradeTypedData(quote);
  if (!typedData) {
    throw new Error(`Quote is missing trade typed data for venue ${quote.venue}`);
  }
  return typedData;
}

function maybeTradeTypedData(quote: FirmQuote): Eip712TypedData | undefined {
  return quote.toSign;
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

function sameAddress(left: Hex, right: Hex): boolean {
  return left.toLowerCase() === right.toLowerCase();
}
