// Package arcusspot is the Go SDK for the Arcus spot router server. It mirrors
// the TypeScript SDK (@arcus-xyz/arcus-spot-sdk): a thin HTTP client for the
// router API plus go-ethereum-based helpers for signing firm quotes, building
// EIP-2612 permits, predicting wrapped-token addresses, and decoding SwapShell
// SwapExecuted logs.
package arcusspot

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math/big"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/common/hexutil"
)

// Venue identifies a routing venue in router responses.
type Venue string

// SupportedVenue values are the venues signQuote/submit support; "bebop" only
// appears in price/quote responses.
const (
	VenueZerox  Venue = "zerox"
	VenueArcus  Venue = "arcus"
	VenueRialto Venue = "rialto"
	VenueLifi   Venue = "lifi"
	VenueBebop  Venue = "bebop"
)

// RouteHop is one hop inside a priced/quoted path.
type RouteHop struct {
	Protocol string          `json:"protocol"`
	ID       string          `json:"id,omitempty"`
	FeeTier  *int            `json:"feeTier,omitempty"`
	From     *common.Address `json:"from,omitempty"`
	To       *common.Address `json:"to,omitempty"`
}

// RoutePath is one path of a quote, with a share of the notional.
type RoutePath struct {
	ProportionBps int        `json:"proportionBps"`
	Hops          []RouteHop `json:"hops"`
}

// QuoteDetails carries the winning or candidate route paths.
type QuoteDetails struct {
	Paths []RoutePath `json:"paths"`
}

// HTTPError is the router's normalized upstream-error shape.
type HTTPError struct {
	Kind    string `json:"kind"` // "timeout" | "network" | "http_4xx" | "http_5xx" | "parse"
	Status  int    `json:"status,omitempty"`
	Message string `json:"message"`
}

// VenueError pairs a venue with the upstream error it produced.
type VenueError struct {
	Venue Venue     `json:"venue"`
	Error HTTPError `json:"error"`
}

// PriceRequest is the query for GET /v1/price.
type PriceRequest struct {
	ChainID    uint64 // optional; 0 omits the parameter
	SellToken  string
	BuyToken   string
	SellAmount string // decimal string, atoms
	// BuilderFeeBps is Arcus-only. Human bps for a builder share. Requires
	// X-Api-Key. Nil omits the parameter; 0 collects none.
	BuilderFeeBps *int
}

// NormalizedPrice is one venue's indicative price.
type NormalizedPrice struct {
	Venue      Venue           `json:"venue"`
	Details    QuoteDetails    `json:"details"`
	BuyAmount  string          `json:"buyAmount"`
	SellAmount string          `json:"sellAmount"`
	Fees       []RouteFee      `json:"fees"`
	Raw        json.RawMessage `json:"raw,omitempty"`
}

// PriceResponse is the body of GET /v1/price.
type PriceResponse struct {
	Recommended Venue             `json:"recommended"`
	Venue       Venue             `json:"venue"`
	Details     QuoteDetails      `json:"details"`
	All         []NormalizedPrice `json:"all"`
	Errors      []VenueError      `json:"errors,omitempty"`
}

// QuoteRequest is the query for GET /v1/quote.
type QuoteRequest struct {
	PriceRequest
	Taker        common.Address
	SlippageBps  *int // optional; nil omits the parameter (0 is meaningful)
	AllowWrapped bool // sent as "true" only when set, mirroring the TS SDK
}

// TypedDataField is one member of an EIP-712 struct type.
type TypedDataField struct {
	Name string `json:"name"`
	Type string `json:"type"`
}

// BigIntish is a big.Int that unmarshals from either a JSON number or a
// decimal/hex string, and marshals back as a JSON number.
type BigIntish big.Int

// UnmarshalJSON accepts numbers, decimal strings, and 0x-prefixed hex strings.
func (b *BigIntish) UnmarshalJSON(data []byte) error {
	s := string(bytes.TrimSpace(data))
	if len(s) >= 2 && s[0] == '"' {
		if err := json.Unmarshal(data, &s); err != nil {
			return err
		}
	}
	i, ok := new(big.Int).SetString(s, 0)
	if !ok {
		return fmt.Errorf("arcusspot: invalid integer value %s", string(data))
	}
	*b = BigIntish(*i)
	return nil
}

// MarshalJSON emits a JSON number.
func (b *BigIntish) MarshalJSON() ([]byte, error) {
	return []byte((*big.Int)(b).String()), nil
}

// Int returns the value as *big.Int.
func (b *BigIntish) Int() *big.Int {
	if b == nil {
		return nil
	}
	return (*big.Int)(b)
}

// NewBigIntish wraps v for use in a TypedDataDomain.
func NewBigIntish(v *big.Int) *BigIntish {
	if v == nil {
		return nil
	}
	return (*BigIntish)(new(big.Int).Set(v))
}

// TypedDataDomain is the EIP-712 domain separator contents.
type TypedDataDomain struct {
	Name              string     `json:"name,omitempty"`
	Version           string     `json:"version,omitempty"`
	ChainID           *BigIntish `json:"chainId,omitempty"`
	VerifyingContract string     `json:"verifyingContract,omitempty"`
	Salt              string     `json:"salt,omitempty"`
}

// Eip712TypedData is an EIP-712 payload as it appears on the wire. Message is
// kept as a raw map so router-provided payloads round-trip byte-compatibly;
// numbers are preserved as json.Number.
type Eip712TypedData struct {
	Domain      TypedDataDomain             `json:"domain"`
	Types       map[string][]TypedDataField `json:"types"`
	PrimaryType string                      `json:"primaryType"`
	Message     map[string]any              `json:"message"`
}

// UnmarshalJSON decodes with json.Number so large integer values inside the
// message survive a decode/encode round trip.
func (t *Eip712TypedData) UnmarshalJSON(data []byte) error {
	type alias Eip712TypedData
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()
	return dec.Decode((*alias)(t))
}

// FlexString is a string field that also accepts a JSON number on the wire
// (the router emits some numeric fields either way) and re-marshals in the
// original form so echoed payloads round-trip byte-compatibly.
type FlexString struct {
	Value string
	// IsNumber records whether the wire value was an unquoted JSON number.
	IsNumber bool
}

// String returns the underlying value.
func (f FlexString) String() string { return f.Value }

// UnmarshalJSON accepts both string and number encodings.
func (f *FlexString) UnmarshalJSON(data []byte) error {
	trimmed := bytes.TrimSpace(data)
	if len(trimmed) > 0 && trimmed[0] == '"' {
		f.IsNumber = false
		return json.Unmarshal(data, &f.Value)
	}
	f.Value = string(trimmed)
	f.IsNumber = true
	return nil
}

// MarshalJSON re-emits the value in its original encoding.
func (f FlexString) MarshalJSON() ([]byte, error) {
	if f.IsNumber {
		return []byte(f.Value), nil
	}
	return json.Marshal(f.Value)
}

// TokenPermission is one Permit2 token permission entry.
type TokenPermission struct {
	Token  common.Address `json:"token"`
	Amount string         `json:"amount"`
}

// RouteFee is a normalized route fee with amount in atoms of Token.
type RouteFee struct {
	Amount    string         `json:"amount"`
	Token     common.Address `json:"token"`
	Type      string         `json:"type"`
	AmountUSD float64        `json:"amountUsd,omitempty"`
	// Bps is the known proportional rate from the buy-token fee leg (human;
	// tenths are allowed, e.g. 3.5). Additive; absolute Amount remains.
	Bps float64 `json:"bps,omitempty"`
}

// TakerIntent is the Arcus RFQ order witness. Public HTTP numeric fields are
// decimal strings, so amounts, nonce, and deadline are string.
type TakerIntent struct {
	Taker          common.Address `json:"taker"`
	TakerSellToken common.Address `json:"takerSellToken"`
	TakerBuyToken  common.Address `json:"takerBuyToken"`
	SellAmount     string         `json:"sellAmount"`
	MinBuyAmount   string         `json:"minBuyAmount"`
	AllowWrapped   bool           `json:"allowWrapped"`
	Nonce          string         `json:"nonce"`
	Deadline       string         `json:"deadline"`
}

// TakerIntentPermit2Message is the PermitWitnessTransferFrom message wrapping a
// TakerIntent witness.
type TakerIntentPermit2Message struct {
	Permitted TokenPermission `json:"permitted"`
	Spender   common.Address  `json:"spender"`
	Nonce     string          `json:"nonce"`
	Deadline  string          `json:"deadline"`
	Witness   TakerIntent     `json:"witness"`
}

// FirmQuote is a venue-specific firm quote from GET /v1/quote.
type FirmQuote interface {
	// FirmQuoteVenue returns the quote's venue discriminator.
	FirmQuoteVenue() Venue
	// TradeTypedData returns the EIP-712 payload the taker signs.
	TradeTypedData() *Eip712TypedData
}

// ZeroxSettlerMetaTransaction is the 0x gasless trade payload.
type ZeroxSettlerMetaTransaction struct {
	Type   string          `json:"type"`
	Hash   string          `json:"hash,omitempty"`
	EIP712 Eip712TypedData `json:"eip712"`
}

// ZeroxGaslessApproval is an optional EIP-2612 approval bundled by 0x.
type ZeroxGaslessApproval struct {
	Type   string          `json:"type"`
	EIP712 Eip712TypedData `json:"eip712"`
}

// ZeroxFirmQuote is a firm quote from the 0x gasless venue.
type ZeroxFirmQuote struct {
	Venue        Venue                        `json:"venue"` // always "zerox"
	Details      QuoteDetails                 `json:"details"`
	BuyAmount    string                       `json:"buyAmount"`
	SellAmount   string                       `json:"sellAmount"`
	MinBuyAmount string                       `json:"minBuyAmount,omitempty"`
	Fees         []RouteFee                   `json:"fees"`
	ToSign       *Eip712TypedData             `json:"toSign,omitempty"`
	Trade        *ZeroxSettlerMetaTransaction `json:"trade,omitempty"`
	Approval     *ZeroxGaslessApproval        `json:"approval,omitempty"`
	Raw          json.RawMessage              `json:"raw"`
}

// FirmQuoteVenue implements FirmQuote.
func (q *ZeroxFirmQuote) FirmQuoteVenue() Venue { return VenueZerox }

// TradeTypedData implements FirmQuote.
func (q *ZeroxFirmQuote) TradeTypedData() *Eip712TypedData {
	if q.ToSign != nil {
		return q.ToSign
	}
	if q.Trade != nil {
		return &q.Trade.EIP712
	}
	return nil
}

// ArcusFirmQuote is a firm quote from the Arcus RFQ venue.
type ArcusFirmQuote struct {
	Venue      Venue           `json:"venue"` // always "arcus"
	Details    QuoteDetails    `json:"details"`
	BuyAmount  string          `json:"buyAmount"`
	SellAmount string          `json:"sellAmount"`
	Fees       []RouteFee      `json:"fees"`
	Expiry     int64           `json:"expiry"`
	ToSign     Eip712TypedData `json:"toSign"`
	Arcus      struct {
		MinAmountOut string `json:"minAmountOut"`
	} `json:"arcus"`
}

// FirmQuoteVenue implements FirmQuote.
func (q *ArcusFirmQuote) FirmQuoteVenue() Venue { return VenueArcus }

// TradeTypedData implements FirmQuote.
func (q *ArcusFirmQuote) TradeTypedData() *Eip712TypedData { return &q.ToSign }

// RialtoTx is the prepared transaction echoed back on rialto submit; the router
// splices the signature into Data at SignatureOffset.
type RialtoTx struct {
	To              common.Address `json:"to"`
	Data            hexutil.Bytes  `json:"data"`
	Value           string         `json:"value"`
	SignatureOffset int            `json:"signatureOffset"`
	EstimatedGas    *FlexString    `json:"estimatedGas,omitempty"`
}

// RialtoFirmQuote is a firm quote from the Rialto venue.
type RialtoFirmQuote struct {
	Venue        Venue           `json:"venue"` // always "rialto"
	Details      QuoteDetails    `json:"details"`
	BuyAmount    string          `json:"buyAmount"`
	SellAmount   string          `json:"sellAmount"`
	MinBuyAmount string          `json:"minBuyAmount"`
	Fees         []RouteFee      `json:"fees"`
	QuoteID      string          `json:"quoteId"`
	ToSign       Eip712TypedData `json:"toSign"`
	Tx           RialtoTx        `json:"tx"`
	// NeedsAllowance is true when the taker needs a one-time sellToken→Permit2
	// approval (build a permit).
	NeedsAllowance bool            `json:"needsAllowance,omitempty"`
	Raw            json.RawMessage `json:"raw,omitempty"`
}

// FirmQuoteVenue implements FirmQuote.
func (q *RialtoFirmQuote) FirmQuoteVenue() Venue { return VenueRialto }

// TradeTypedData implements FirmQuote.
func (q *RialtoFirmQuote) TradeTypedData() *Eip712TypedData { return &q.ToSign }

// LifiTx is the prepared LI.FI call echoed back on submit.
type LifiTx struct {
	Permit2Proxy    common.Address `json:"permit2Proxy"`
	DiamondCalldata hexutil.Bytes  `json:"diamondCalldata"`
	BuyToken        common.Address `json:"buyToken"`
	Value           string         `json:"value"`
	EstimatedGas    *FlexString    `json:"estimatedGas,omitempty"`
}

// LifiQuoteRaw is the subset of the raw LI.FI quote the router validates on
// submit. Unknown fields are preserved nowhere; the SDK echoes the exact
// document it received via LifiFirmQuote.Raw.
type LifiQuoteRaw = json.RawMessage

// LifiFirmQuote is a firm quote from the LI.FI venue.
type LifiFirmQuote struct {
	Venue        Venue           `json:"venue"` // always "lifi"
	Details      QuoteDetails    `json:"details"`
	BuyAmount    string          `json:"buyAmount"`
	SellAmount   string          `json:"sellAmount"`
	MinBuyAmount string          `json:"minBuyAmount"`
	Fees         []RouteFee      `json:"fees"`
	QuoteID      string          `json:"quoteId"`
	ToSign       Eip712TypedData `json:"toSign"`
	Tx           LifiTx          `json:"tx"`
	// NeedsAllowance is true when the taker needs a one-time sellToken→Permit2
	// approval (build a permit).
	NeedsAllowance bool         `json:"needsAllowance,omitempty"`
	Raw            LifiQuoteRaw `json:"raw"`
}

// FirmQuoteVenue implements FirmQuote.
func (q *LifiFirmQuote) FirmQuoteVenue() Venue { return VenueLifi }

// TradeTypedData implements FirmQuote.
func (q *LifiFirmQuote) TradeTypedData() *Eip712TypedData { return &q.ToSign }

// BebopFirmQuote is a firm quote from the Bebop venue. SignQuote does not
// support bebop; the type exists so quote responses parse losslessly.
type BebopFirmQuote struct {
	Venue      Venue           `json:"venue"` // always "bebop"
	Details    QuoteDetails    `json:"details"`
	BuyAmount  string          `json:"buyAmount"`
	SellAmount string          `json:"sellAmount"`
	Fees       []RouteFee      `json:"fees"`
	QuoteID    string          `json:"quoteId"`
	Expiry     int64           `json:"expiry"`
	ToSign     Eip712TypedData `json:"toSign"`
	Raw        json.RawMessage `json:"raw"`
}

// FirmQuoteVenue implements FirmQuote.
func (q *BebopFirmQuote) FirmQuoteVenue() Venue { return VenueBebop }

// TradeTypedData implements FirmQuote.
func (q *BebopFirmQuote) TradeTypedData() *Eip712TypedData { return &q.ToSign }

// QuoteResponse is the body of GET /v1/quote. Quotes with venues this SDK
// version does not know are skipped so new venues stay forward-compatible.
type QuoteResponse struct {
	Recommended Venue        `json:"recommended"`
	Venue       Venue        `json:"venue"`
	Details     QuoteDetails `json:"details"`
	All         []FirmQuote  `json:"all"`
	Errors      []VenueError `json:"errors,omitempty"`
}

// UnmarshalJSON dispatches each entry of "all" to its concrete quote type based
// on the venue discriminator.
func (r *QuoteResponse) UnmarshalJSON(data []byte) error {
	var raw struct {
		Recommended Venue             `json:"recommended"`
		Venue       Venue             `json:"venue"`
		Details     QuoteDetails      `json:"details"`
		All         []json.RawMessage `json:"all"`
		Errors      []VenueError      `json:"errors"`
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	r.Recommended = raw.Recommended
	r.Venue = raw.Venue
	r.Details = raw.Details
	r.Errors = raw.Errors
	r.All = r.All[:0]
	for _, entry := range raw.All {
		quote, err := unmarshalFirmQuote(entry)
		if err != nil {
			return err
		}
		if quote != nil {
			r.All = append(r.All, quote)
		}
	}
	return nil
}

func unmarshalFirmQuote(data json.RawMessage) (FirmQuote, error) {
	var peek struct {
		Venue Venue `json:"venue"`
	}
	if err := json.Unmarshal(data, &peek); err != nil {
		return nil, fmt.Errorf("arcusspot: firm quote missing venue: %w", err)
	}
	var quote FirmQuote
	switch peek.Venue {
	case VenueZerox:
		quote = &ZeroxFirmQuote{}
	case VenueArcus:
		quote = &ArcusFirmQuote{}
	case VenueRialto:
		quote = &RialtoFirmQuote{}
	case VenueLifi:
		quote = &LifiFirmQuote{}
	case VenueBebop:
		quote = &BebopFirmQuote{}
	default:
		return nil, nil // unknown venue: skip for forward compatibility
	}
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()
	if err := dec.Decode(quote); err != nil {
		return nil, fmt.Errorf("arcusspot: decode %s firm quote: %w", peek.Venue, err)
	}
	return quote, nil
}

// SplitSignature is a 65-byte ECDSA signature split into components with the
// SwapShell signatureType discriminator.
type SplitSignature struct {
	SignatureType int         `json:"signatureType"` // always 2
	V             uint8       `json:"v"`
	R             common.Hash `json:"r"`
	S             common.Hash `json:"s"`
}

// Permit is an EIP-2612 permit folded into SwapShell's permits[] argument. The
// router calls token.permit(...) before the swap routes through Settler. One
// entry per token approval.
type Permit struct {
	Token    common.Address `json:"token"`
	Value    string         `json:"value"`
	Deadline string         `json:"deadline"`
	V        uint8          `json:"v"`
	R        common.Hash    `json:"r"`
	S        common.Hash    `json:"s"`
}

// SignedQuote is a signed quote body for POST /v1/submit.
type SignedQuote interface {
	// SignedQuoteVenue returns the venue discriminator serialized in the body.
	SignedQuoteVenue() Venue
}

// ArcusSignedQuote is the submit body for the arcus venue. The router forwards
// it to the aggregator, which runs the maker firm-quote round and broadcasts.
type ArcusSignedQuote struct {
	Venue     Venue           `json:"venue"` // always "arcus"
	ChainID   uint64          `json:"chainId"`
	Taker     common.Address  `json:"taker"`
	TypedData Eip712TypedData `json:"typedData"`
	Signature hexutil.Bytes   `json:"signature"`
	// Permits optionally carries an EIP-2612 permit for a first-time
	// sellToken→Permit2 allowance.
	Permits []Permit `json:"permits,omitempty"`
	// RouteTag is an optional discriminator surfaced as bytes32 in the
	// SwapShell event.
	RouteTag string `json:"routeTag,omitempty"`
	// BuilderFeeBps is the same per-request builder bps as /price /quote
	// (must be ≤ the key max).
	BuilderFeeBps *int `json:"builderFeeBps,omitempty"`
}

// ZeroxSignedQuote is the submit body for the zerox venue.
type ZeroxSignedQuote struct {
	Venue           Venue           `json:"venue"` // always "zerox"
	ChainID         uint64          `json:"chainId"`
	Taker           common.Address  `json:"taker"`
	TypedData       Eip712TypedData `json:"typedData"`
	Signature       hexutil.Bytes   `json:"signature"`
	QuotedAmountIn  string          `json:"quotedAmountIn,omitempty"`
	QuotedAmountOut string          `json:"quotedAmountOut,omitempty"`
	Permits         []Permit        `json:"permits,omitempty"`
}

// SignedQuoteVenue implements SignedQuote.
func (q *ZeroxSignedQuote) SignedQuoteVenue() Venue { return VenueZerox }

// SignedQuoteVenue implements SignedQuote.
func (q *ArcusSignedQuote) SignedQuoteVenue() Venue { return VenueArcus }

// RialtoSignedQuote is the submit body for the rialto venue. The taker echoes
// back the prepared tx (the router splices the signature into tx.data); the
// relayer forwards through SwapShell → RialtoRouter.
type RialtoSignedQuote struct {
	Venue           Venue           `json:"venue"` // always "rialto"
	ChainID         uint64          `json:"chainId"`
	Taker           common.Address  `json:"taker"`
	TypedData       Eip712TypedData `json:"typedData"`
	Signature       hexutil.Bytes   `json:"signature"`
	Tx              RialtoTx        `json:"tx"`
	Permits         []Permit        `json:"permits,omitempty"`
	QuotedAmountIn  string          `json:"quotedAmountIn,omitempty"`
	QuotedAmountOut string          `json:"quotedAmountOut,omitempty"`
	RouteTag        string          `json:"routeTag,omitempty"`
}

// SignedQuoteVenue implements SignedQuote.
func (q *RialtoSignedQuote) SignedQuoteVenue() Venue { return VenueRialto }

// LifiSignedQuote is the submit body for the lifi venue. Echoes the prepared tx
// and raw quote from /quote so the router can validate diamond calldata and
// buyToken.
type LifiSignedQuote struct {
	Venue           Venue           `json:"venue"` // always "lifi"
	ChainID         uint64          `json:"chainId"`
	Taker           common.Address  `json:"taker"`
	TypedData       Eip712TypedData `json:"typedData"`
	Signature       hexutil.Bytes   `json:"signature"`
	Tx              LifiTx          `json:"tx"`
	Raw             LifiQuoteRaw    `json:"raw"`
	MinBuyAmount    string          `json:"minBuyAmount"`
	Permits         []Permit        `json:"permits,omitempty"`
	QuotedAmountIn  string          `json:"quotedAmountIn,omitempty"`
	QuotedAmountOut string          `json:"quotedAmountOut,omitempty"`
	RouteTag        string          `json:"routeTag,omitempty"`
}

// SignedQuoteVenue implements SignedQuote.
func (q *LifiSignedQuote) SignedQuoteVenue() Venue { return VenueLifi }

// SubmitResponse is the body of POST /v1/submit. Maker, Wrapped, SettledToken,
// and OrderID are only populated for the arcus venue.
type SubmitResponse struct {
	Venue        Venue           `json:"venue"`
	Details      QuoteDetails    `json:"details"`
	TxHash       common.Hash     `json:"txHash"`
	Status       string          `json:"status"` // always "submitted"
	Maker        *common.Address `json:"maker,omitempty"`
	Wrapped      *bool           `json:"wrapped,omitempty"`
	SettledToken *common.Address `json:"settledToken,omitempty"`
	OrderID      string          `json:"orderId,omitempty"`
}

// NormalizedStatus is the router's normalized order status.
type NormalizedStatus string

// NormalizedStatus values.
const (
	StatusPending   NormalizedStatus = "pending"
	StatusSubmitted NormalizedStatus = "submitted"
	StatusConfirmed NormalizedStatus = "confirmed"
	StatusFailed    NormalizedStatus = "failed"
	StatusUnknown   NormalizedStatus = "unknown"
)

// StatusRequest is the query for GET /v1/status.
type StatusRequest struct {
	Venue   Venue  // one of the supported venues (zerox | arcus | rialto | lifi)
	ID      string // tx hash or order id, 0x-prefixed
	ChainID uint64 // optional; 0 omits the parameter
}

// StatusResponse is the body of GET /v1/status.
type StatusResponse struct {
	Venue     Venue            `json:"venue"`
	Status    NormalizedStatus `json:"status"`
	RawStatus string           `json:"rawStatus,omitempty"`
	TxHash    string           `json:"txHash,omitempty"`
	Raw       json.RawMessage  `json:"raw"`
}

// TokenCategory classifies a token in the router's token list.
type TokenCategory string

// TokenCategory values.
const (
	TokenCategoryStock     TokenCategory = "stock"
	TokenCategoryCommodity TokenCategory = "commodity"
	TokenCategoryCrypto    TokenCategory = "crypto"
	TokenCategoryIndex     TokenCategory = "index"
	TokenCategoryMeme      TokenCategory = "meme"
	TokenCategoryPToken    TokenCategory = "pToken"
)

// TokenInfo is one entry of GET /v1/tokens.
type TokenInfo struct {
	ChainID  uint64         `json:"chainId"`
	Address  common.Address `json:"address"`
	Symbol   string         `json:"symbol"`
	Name     string         `json:"name"`
	Decimals int            `json:"decimals"`
	Source   string         `json:"source"`
	Category TokenCategory  `json:"category"`
	// AddedTimestamp is when the token was first listed, unix ms UTC. Absent
	// for admin-added records that predate tracking.
	AddedTimestamp *int64 `json:"addedTimestamp,omitempty"`
	// Verified is true for curated / real-world assets. Every non-meme category
	// is verified by default; meme tokens start unverified until an admin
	// promotes them.
	Verified bool `json:"verified"`
	// WrappedTokenAddress is the canonical wrapped representation for Arcus RFQ
	// routing (RH testnet stock tokens).
	WrappedTokenAddress *common.Address `json:"wrappedTokenAddress,omitempty"`
}

// HealthResponse is the body of the unversioned GET /health.
type HealthResponse struct {
	OK      bool   `json:"ok"`
	ChainID uint64 `json:"chainId"`
}
