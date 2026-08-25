import type { Hex, TypedDataDomain } from "viem";

export type SupportedVenue = "arcus" | "rialto" | "lifi";
export type Venue = SupportedVenue | "bebop";

export type HttpError = {
  kind: "timeout" | "network" | "http_4xx" | "http_5xx" | "parse";
  status?: number;
  message: string;
};

export type ClientOptions = {
  baseUrl: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
};

export type PriceRequest = {
  chainId?: number;
  sellToken: string;
  buyToken: string;
  sellAmount: string;
};

export type NormalizedPrice = {
  venue: Venue;
  buyAmount: string;
  sellAmount: string;
  raw?: BebopQuoteRaw;
};

export type PriceResponse = {
  recommended: Venue;
  all: NormalizedPrice[];
  errors?: { venue: Venue; error: HttpError }[];
};

export type QuoteRequest = PriceRequest & {
  taker: Hex;
  slippageBps?: number;
  allowWrapped?: boolean;
};

export type Eip712TypedData = {
  domain: TypedDataDomain;
  types: Record<string, { name: string; type: string }[]>;
  primaryType: string;
  message: Record<string, unknown>;
};

export type TokenPermission = {
  token: Hex;
  amount: string;
};

export type RouteFee = {
  amount: string;
  token: Hex;
  type: string;
  amountUsd?: number;
  /** Human basis points when the venue reports them (may be tenths, e.g. 3.5). */
  bps?: number;
};

export type BebopJamOrder = {
  taker: Hex;
  receiver: Hex;
  expiry: number | string;
  exclusivityDeadline: number | string;
  nonce: string;
  executor: Hex;
  partnerInfo: string;
  sellTokens: Hex[];
  buyTokens: Hex[];
  sellAmounts: string[];
  buyAmounts: string[];
  hooksHash: Hex;
};

export type BebopPermitBatchWitnessTransferFromMessage = {
  permitted: TokenPermission[];
  spender: Hex;
  nonce: string;
  deadline: number | string;
  witness: BebopJamOrder;
};

export type BebopTypedData = Eip712TypedData & {
  primaryType: "PermitBatchWitnessTransferFrom";
  message: BebopPermitBatchWitnessTransferFromMessage;
};

export type BebopTokenQuote = {
  amount: string;
  decimals: number;
  priceUsd?: number;
  symbol: string;
  minimumAmount?: string;
  price?: number;
  priceBeforeFee?: number;
  amountBeforeFee?: string;
  deltaFromExpected?: number;
};

export type BebopQuoteRaw = {
  requestId: string;
  type: string;
  status: string;
  quoteId: string;
  chainId: number;
  approvalType: "Permit2" | string;
  nativeToken: string;
  taker: Hex;
  receiver: Hex;
  expiry: number;
  slippage: number;
  gasFee?: {
    native: string;
    usd: number;
  };
  buyTokens: Record<Hex, BebopTokenQuote>;
  sellTokens: Record<Hex, BebopTokenQuote>;
  settlementAddress: Hex;
  approvalTarget: Hex;
  requiredSignatures: Hex[];
  priceImpact?: number;
  warnings: unknown[];
  hooksHash: Hex;
  toSign: BebopPermitBatchWitnessTransferFromMessage;
  solver?: string;
};

export type BebopFirmQuote = {
  venue: "bebop";
  buyAmount: string;
  sellAmount: string;
  fees: RouteFee[];
  quoteId: string;
  expiry: number;
  toSign: BebopTypedData;
  raw: BebopQuoteRaw;
};

// ── Arcus RFQ order (taker side) ─────────────────────────────────────────────
// Canonical Arcus RFQ order shapes that mirror the on-chain / router wire
// format. Public HTTP numeric fields are decimal strings, so amounts, nonce, and
// deadline are `string`. TakerIntentPermit2TypedData stays on the SDK's local
// Eip712TypedData base to keep `toSign` assignable to the SDK's signing helpers.
export type TakerIntent = {
  taker: Hex;
  takerSellToken: Hex;
  takerBuyToken: Hex;
  sellAmount: string;
  minBuyAmount: string;
  allowWrapped: boolean;
  nonce: string;
  deadline: string;
};

export type TakerIntentPermit2Message = {
  permitted: TokenPermission;
  spender: Hex;
  nonce: string;
  deadline: string;
  witness: TakerIntent;
};

export type TakerIntentPermit2TypedData = Eip712TypedData & {
  primaryType: "PermitWitnessTransferFrom";
  message: TakerIntentPermit2Message;
};

export type ArcusFirmQuote = {
  venue: "arcus";
  /** Post-fee (net) amount the taker keeps. Do not subtract `fees` again. */
  buyAmount: string;
  sellAmount: string;
  fees: RouteFee[];
  expiry: number;
  toSign: TakerIntentPermit2TypedData;
  arcus: {
    /**
     * Signed delivery floor. Net of buy-token fees; unchanged when the fee is
     * taken from the sell token.
     */
    minAmountOut: string;
  };
};

export type RialtoTx = {
  to: Hex;
  data: Hex;
  value: string;
  signatureOffset: number;
  estimatedGas?: string;
};

export type RialtoFirmQuote = {
  venue: "rialto";
  buyAmount: string;
  sellAmount: string;
  minBuyAmount: string;
  fees: RouteFee[];
  quoteId: string;
  toSign: Eip712TypedData;
  tx: RialtoTx;
  /** True when the taker needs a one-time sellToken→Permit2 approval (build a permit). */
  needsAllowance?: boolean;
};

export type LifiTx = {
  permit2Proxy: Hex;
  diamondCalldata: Hex;
  buyToken: Hex;
  value: string;
  estimatedGas?: string;
};

export type LifiQuoteRaw = {
  id?: string;
  action?: {
    fromToken?: { address?: string };
    toToken?: { address?: string };
    fromAmount?: string;
    fromChainId?: number;
    toChainId?: number;
  };
  estimate?: {
    toAmount?: string;
    toAmountMin?: string;
    fromAmount?: string;
    approvalAddress?: string;
  };
  transactionRequest?: {
    to?: string;
    data?: string;
    value?: string;
    gasLimit?: string;
  };
};

export type LifiFirmQuote = {
  venue: "lifi";
  buyAmount: string;
  sellAmount: string;
  minBuyAmount: string;
  fees: RouteFee[];
  quoteId: string;
  toSign: Eip712TypedData;
  tx: LifiTx;
  /** True when the taker needs a one-time sellToken→Permit2 approval (build a permit). */
  needsAllowance?: boolean;
  raw: LifiQuoteRaw;
};

export type FirmQuote = BebopFirmQuote | ArcusFirmQuote | RialtoFirmQuote | LifiFirmQuote;

export type QuoteResponse = {
  recommended: FirmQuote["venue"];
  all: FirmQuote[];
  errors?: { venue: Venue; error: HttpError }[];
};

export type SplitSignature = {
  signatureType: 2;
  v: number;
  r: Hex;
  s: Hex;
};

/**
 * EIP-2612 permit folded into SwapShell's permits[] argument. The router will
 * call `token.permit(...)` before the swap routes through Settler. One entry
 * per token approval.
 */
export type Permit = {
  token: Hex;
  value: string;
  deadline: string;
  v: number;
  r: Hex;
  s: Hex;
};

/**
 * Body shape POSTed to the router's /v1/submit for the arcus venue. The router
 * forwards it to the aggregator, which runs the maker firm-quote round and
 * broadcasts
 */
export type ArcusSignedQuote = {
  venue: "arcus";
  chainId: number;
  taker: Hex;
  typedData: TakerIntentPermit2TypedData;
  signature: Hex;
  /** Optional EIP-2612 permit for a first-time sellToken→Permit2 allowance. */
  permits?: Permit[];
  /** Optional discriminator surfaced as bytes32 in the SwapShell event. */
  routeTag?: string;
};

/**
 * Body POSTed to the router's /v1/submit for the rialto venue. The taker echoes
 * back the prepared `tx` (the router splices the signature into `tx.data`); the
 * relayer forwards through SwapShell → RialtoRouter.
 */
export type RialtoSignedQuote = {
  venue: "rialto";
  chainId: number;
  taker: Hex;
  typedData: Eip712TypedData;
  signature: Hex;
  tx: RialtoTx;
  /** Optional EIP-2612 permit for a first-time sellToken→Permit2 allowance. */
  permits?: Permit[];
  quotedAmountIn?: string;
  quotedAmountOut?: string;
  routeTag?: string;
};

/**
 * Body POSTed to the router's /v1/submit for the lifi venue. Echoes the prepared
 * `tx` and `raw` from /quote so the router can validate diamond calldata and buyToken.
 */
export type LifiSignedQuote = {
  venue: "lifi";
  chainId: number;
  taker: Hex;
  typedData: Eip712TypedData;
  signature: Hex;
  tx: LifiTx;
  raw: LifiQuoteRaw;
  minBuyAmount: string;
  /** Optional EIP-2612 permit for a first-time sellToken→Permit2 allowance. */
  permits?: Permit[];
  quotedAmountIn?: string;
  quotedAmountOut?: string;
  routeTag?: string;
};

export type SignedQuote = ArcusSignedQuote | RialtoSignedQuote | LifiSignedQuote;

export type ArcusSubmitResponse = {
  venue: "arcus";
  txHash: Hex;
  status: "submitted";
  maker?: Hex;
  wrapped?: boolean;
  settledToken?: Hex;
  orderId?: Hex;
};

export type RialtoSubmitResponse = {
  venue: "rialto";
  txHash: Hex;
  status: "submitted";
};

export type LifiSubmitResponse = {
  venue: "lifi";
  txHash: Hex;
  status: "submitted";
};

export type SubmitResponse = ArcusSubmitResponse | RialtoSubmitResponse | LifiSubmitResponse;

export type NormalizedStatus = "pending" | "submitted" | "confirmed" | "failed" | "unknown";

export type StatusRequest = {
  venue: SupportedVenue;
  id: Hex;
  chainId?: number;
};

export type StatusResponse = {
  venue: Venue;
  status: NormalizedStatus;
  rawStatus?: string;
  txHash?: Hex;
  raw: unknown;
};

export type TokenCategory = "stock" | "commodity" | "crypto" | "index" | "meme";

export type TokenInfo = {
  chainId: number;
  address: Hex;
  symbol: string;
  name: string;
  decimals: number;
  source: string;
  category: TokenCategory;
  /**
   * True for curated / real-world assets. Every non-meme category is verified by
   * default; meme tokens start unverified until an admin promotes them.
   */
  verified: boolean;
  /** Canonical wrapped representation for Arcus RFQ routing (RH testnet stock tokens). */
  wrappedTokenAddress?: Hex | null;
};
