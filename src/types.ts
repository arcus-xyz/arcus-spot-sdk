import type { Hex, TypedDataDomain } from "viem";

export type SupportedVenue = "zerox" | "arcus" | "rialto" | "lifi";
export type Venue = SupportedVenue | "bebop";

export type RouteHop = {
  protocol: string;
  id?: string;
  feeTier?: number;
  from?: Hex;
  to?: Hex;
};

export type RoutePath = {
  proportionBps: number;
  hops: RouteHop[];
};

export type QuoteDetails = {
  paths: RoutePath[];
};

export type HttpError = {
  kind: "timeout" | "network" | "http_4xx" | "http_5xx" | "parse";
  status?: number;
  message: string;
};

export type ClientOptions = {
  baseUrl: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  /**
   * Router API key, sent as `X-Api-Key` on every request. Issued per client;
   * keys used from a browser or mobile bundle are publishable identifiers
   * rather than secrets, and are hardened by per-key origin pinning on the
   * server. Omit it against a router that is not enforcing keys.
   */
  apiKey?: string;
};

export type PriceRequest = {
  chainId?: number;
  sellToken: string;
  buyToken: string;
  sellAmount: string;
  /**
   * Arcus only. Human bps for a builder share. Requires `X-Api-Key`.
   * Omitted or `0` collects none; `N > 0` must be ≤ the key's max `builderFeeBps`.
   * Repeat the same value on `/submit` (`ArcusSignedQuote.builderFeeBps`).
   */
  builderFeeBps?: number;
};

export type NormalizedPrice = {
  venue: Venue;
  details: QuoteDetails;
  buyAmount: string;
  sellAmount: string;
  fees: RouteFee[];
  raw?: ZeroxGaslessPriceRaw | BebopQuoteRaw;
};

export type PriceResponse = {
  recommended: Venue;
  /** Winning venue. Same value as `recommended`. */
  venue: Venue;
  details: QuoteDetails;
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

export type ZeroxQuotePart = {
  type: string;
  eip712: Eip712TypedData;
};

export type ZeroxGaslessApproval = {
  type: "permit";
  eip712: Eip712TypedData;
};

export type ZeroxSlippageAndActions = {
  recipient: Hex;
  buyToken: Hex;
  minAmountOut: string;
  actions: Hex[];
};

export type ZeroxPermitWitnessTransferFromMessage = {
  permitted: TokenPermission;
  spender: Hex;
  nonce: string;
  deadline: string;
  slippageAndActions: ZeroxSlippageAndActions;
};

export type ZeroxSettlerMetaTransaction = {
  type: string;
  hash?: Hex;
  eip712: Eip712TypedData & {
    message: ZeroxPermitWitnessTransferFromMessage;
  };
};

export type RouteFee = {
  amount: string;
  token: Hex;
  type: string;
  amountUsd?: number;
  /** Basis points collected from the buy-token fee leg when known (human; may be tenths e.g. 3.5). Additive; absolute `amount` remains. */
  bps?: number;
};

/** Known Arcus `fees[].type` values. Other venues still use free-form strings (`volume`, …). */
export type ArcusRouteFeeType = "protocol" | "gas" | "builder";

export type ZeroxFee = RouteFee;

export type ZeroxTokenTaxMetadata = {
  buyTaxBps: string;
  sellTaxBps: string;
  transferTaxBps: string;
};

export type ZeroxGaslessQuoteRaw = {
  allowanceTarget?: Hex;
  approval?: ZeroxGaslessApproval | null;
  blockNumber?: string;
  buyAmount?: string;
  buyToken?: Hex;
  fees?: {
    integratorFee?: ZeroxFee | null;
    integratorFees?: ZeroxFee[] | null;
    zeroExFee?: ZeroxFee | null;
    gasFee?: ZeroxFee | null;
  };
  issues?: {
    allowance?: unknown | null;
    balance?: unknown | null;
    simulationIncomplete?: boolean;
    invalidSourcesPassed?: string[];
  };
  liquidityAvailable?: boolean;
  minBuyAmount?: string;
  route?: {
    fills: {
      from?: Hex;
      to?: Hex;
      source: string;
      proportionBps: string;
    }[];
    tokens?: {
      address: Hex;
      symbol: string;
    }[];
  };
  sellAmount?: string;
  sellToken?: Hex;
  target?: Hex;
  tokenMetadata?: {
    buyToken?: ZeroxTokenTaxMetadata;
    sellToken?: ZeroxTokenTaxMetadata;
  };
  trade?: ZeroxSettlerMetaTransaction;
  zid?: Hex;
};

export type ZeroxGaslessPriceRaw = Pick<
  ZeroxGaslessQuoteRaw,
  "buyAmount" | "fees" | "liquidityAvailable" | "sellAmount"
>;

export type ZeroxFirmQuote = {
  venue: "zerox";
  details: QuoteDetails;
  buyAmount: string;
  sellAmount: string;
  minBuyAmount?: string;
  fees: RouteFee[];
  /** Permit2 PermitWitnessTransferFrom EIP-712 the taker signs for the trade. */
  toSign?: Eip712TypedData;
  /** 0x gasless trade payload; some router responses expose this instead of `toSign`. */
  trade?: ZeroxSettlerMetaTransaction;
  /** Optional EIP-2612 approval 0x bundles when token→Permit2 allowance is 0. */
  approval?: ZeroxGaslessApproval | ZeroxQuotePart | null;
  raw: ZeroxGaslessQuoteRaw;
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
  details: QuoteDetails;
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
  details: QuoteDetails;
  buyAmount: string;
  sellAmount: string;
  fees: RouteFee[];
  expiry: number;
  toSign: TakerIntentPermit2TypedData;
  arcus: {
    minAmountOut: string;
  };
};

export type RialtoTx = {
  to: Hex;
  data: Hex;
  value: string;
  signatureOffset: number;
  estimatedGas?: number | string;
};

export type RialtoSwapWitness = {
  recipient: Hex;
  buyToken: Hex;
  minBuyAmount: string;
  deadline: number | string;
  feeRecipient: Hex;
  srcBps: number;
  dstBps: number;
  referralCode: Hex;
  quoteId: Hex;
  actionsHash: Hex;
};

export type RialtoPermitWitnessTransferFromMessage = {
  permitted: TokenPermission;
  spender: Hex;
  nonce: string;
  deadline: string;
  witness: RialtoSwapWitness;
};

export type RialtoTypedData = Eip712TypedData & {
  primaryType: "PermitWitnessTransferFrom";
  message: RialtoPermitWitnessTransferFromMessage;
  owner?: Hex;
  nonce?: string;
  deadline?: number | string;
};

export type RialtoQuoteRaw = {
  quote_id?: string;
  settlement?: string;
  tx?: {
    to?: Hex;
    data?: Hex;
    value?: string;
    estimated_gas?: number | string;
    signature_offset?: number;
  };
  permit2?: RialtoTypedData | null;
  chain_id?: number;
  sell_token?: Hex;
  buy_token?: Hex;
  sell_amount?: string;
  buy_amount?: string;
  min_buy_amount?: string;
  platform_fee?: {
    total_bps?: number | string;
    fees?: {
      side?: string;
      token?: Hex;
      symbol?: string;
      decimals?: number;
      bps?: string;
      bps_x100?: number;
      amount?: string;
      amount_decimal?: string;
      recipient?: Hex;
    }[];
  } | null;
  integrator_fee?: { bps?: number; recipient?: Hex; id?: string } | null;
  network_fee?: {
    token?: Hex;
    symbol?: string;
    decimals?: number;
    gas?: string;
    gas_price?: string;
    gas_price_gwei?: string;
    amount?: string;
    amount_gwei?: string;
    amount_eth?: string;
  };
  issues?: {
    allowance?: { actual?: string; spender?: string; token?: Hex } | null;
    balance?: { token?: Hex; actual?: string; expected?: string } | null;
    simulationIncomplete?: boolean;
    invalidSourcesPassed?: string[];
  };
  taker?: Hex;
  slippage_bps?: number;
  candidate_paths?: number;
  successful_routes?: number;
  failed_routes?: number;
  route?: {
    sell_amount?: string;
    buy_amount?: string;
    gas_estimate?: number | string;
    legs?: {
      pool_id?: string;
      sell_token?: Hex;
      buy_token?: Hex;
      sell_amount?: string;
      buy_amount?: string;
    }[];
  };
};

export type RialtoFirmQuote = {
  venue: "rialto";
  details: QuoteDetails;
  buyAmount: string;
  sellAmount: string;
  minBuyAmount: string;
  fees: RouteFee[];
  quoteId: string;
  toSign: RialtoTypedData;
  tx: RialtoTx;
  /** True when the taker needs a one-time sellToken→Permit2 approval (build a permit). */
  needsAllowance?: boolean;
  raw: RialtoQuoteRaw;
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
  includedSteps?: {
    tool?: string;
    toolDetails?: { key?: string; name?: string };
    action?: { fromToken?: { address?: string }; toToken?: { address?: string } };
  }[];
};

export type LifiFirmQuote = {
  venue: "lifi";
  details: QuoteDetails;
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

export type FirmQuote =
  ZeroxFirmQuote | BebopFirmQuote | ArcusFirmQuote | RialtoFirmQuote | LifiFirmQuote;

export type QuoteResponse = {
  recommended: FirmQuote["venue"];
  /** Winning venue. Same value as `recommended`. */
  venue: FirmQuote["venue"];
  details: QuoteDetails;
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
 * Body shape POSTed to the router's /v1/submit for the zerox venue. The trade
 * EIP-712 is the user's PermitWitnessTransferFrom signature
 */
export type ZeroxSignedQuote = {
  venue: "zerox";
  chainId: number;
  taker: Hex;
  typedData: Eip712TypedData;
  signature: Hex;
  quotedAmountIn?: string;
  quotedAmountOut?: string;
  permits?: Permit[];
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
  /** Same per-request builder bps as `/price` `/quote` (must be ≤ the key max). */
  builderFeeBps?: number;
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
  typedData: RialtoTypedData;
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

export type SignedQuote = ZeroxSignedQuote | ArcusSignedQuote | RialtoSignedQuote | LifiSignedQuote;

export type ArcusSubmitResponse = {
  venue: "arcus";
  details: QuoteDetails;
  txHash: Hex;
  status: "submitted";
  maker?: Hex;
  wrapped?: boolean;
  settledToken?: Hex;
  orderId?: Hex;
};

export type ZeroxSubmitResponse = {
  venue: "zerox";
  details: QuoteDetails;
  txHash: Hex;
  status: "submitted";
};

export type RialtoSubmitResponse = {
  venue: "rialto";
  details: QuoteDetails;
  txHash: Hex;
  status: "submitted";
};

export type LifiSubmitResponse = {
  venue: "lifi";
  details: QuoteDetails;
  txHash: Hex;
  status: "submitted";
};

export type SubmitResponse =
  ArcusSubmitResponse | ZeroxSubmitResponse | RialtoSubmitResponse | LifiSubmitResponse;

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

export type TokenCategory = "stock" | "commodity" | "crypto" | "index" | "meme" | "pToken";

export type TokenInfo = {
  chainId: number;
  address: Hex;
  symbol: string;
  name: string;
  decimals: number;
  source: string;
  category: TokenCategory;
  /**
   * When the token was first listed, unix ms UTC. Absent for admin-added
   * records that predate tracking.
   */
  addedTimestamp?: number;
  /**
   * True for curated / real-world assets. Every non-meme category is verified by
   * default; meme tokens start unverified until an admin promotes them.
   */
  verified: boolean;
  /** Canonical wrapped representation for Arcus RFQ routing (RH testnet stock tokens). */
  wrappedTokenAddress?: Hex | null;
};
