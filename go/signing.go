package arcusspot

import (
	"crypto/ecdsa"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/common/math"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/ethereum/go-ethereum/signer/core/apitypes"
)

// TypedDataSigner signs EIP-712 payloads. Implementations must return a
// 65-byte r||s||v signature with v in {27, 28}.
type TypedDataSigner interface {
	// Address returns the signing account address.
	Address() common.Address
	// SignTypedData signs the EIP-712 digest of typedData.
	SignTypedData(typedData Eip712TypedData) ([]byte, error)
}

// PrivateKeySigner signs typed data with an in-memory secp256k1 private key.
type PrivateKeySigner struct {
	key     *ecdsa.PrivateKey
	address common.Address
}

// NewPrivateKeySigner wraps key in a TypedDataSigner.
func NewPrivateKeySigner(key *ecdsa.PrivateKey) *PrivateKeySigner {
	return &PrivateKeySigner{key: key, address: crypto.PubkeyToAddress(key.PublicKey)}
}

// Address implements TypedDataSigner.
func (s *PrivateKeySigner) Address() common.Address { return s.address }

// SignTypedData implements TypedDataSigner.
func (s *PrivateKeySigner) SignTypedData(typedData Eip712TypedData) ([]byte, error) {
	digest, err := HashTypedData(typedData)
	if err != nil {
		return nil, err
	}
	signature, err := crypto.Sign(digest.Bytes(), s.key)
	if err != nil {
		return nil, err
	}
	// crypto.Sign yields v in {0, 1}; wallets and the router expect {27, 28}.
	signature[64] += 27
	return signature, nil
}

// HashTypedData computes the EIP-712 digest of typedData
// (keccak256("\x19\x01" ‖ domainSeparator ‖ hashStruct(message))).
func HashTypedData(typedData Eip712TypedData) (common.Hash, error) {
	converted, err := toAPITypedData(typedData)
	if err != nil {
		return common.Hash{}, err
	}
	digest, _, err := apitypes.TypedDataAndHash(converted)
	if err != nil {
		return common.Hash{}, fmt.Errorf("arcusspot: hash typed data: %w", err)
	}
	return common.BytesToHash(digest), nil
}

// toAPITypedData converts the SDK's wire-shaped typed data to go-ethereum's
// apitypes representation. Like viem, any EIP712Domain entry in Types is
// discarded and rebuilt from the domain fields that are actually present.
func toAPITypedData(typedData Eip712TypedData) (apitypes.TypedData, error) {
	types := apitypes.Types{}
	for name, fields := range typedData.Types {
		if name == "EIP712Domain" {
			continue
		}
		converted := make([]apitypes.Type, len(fields))
		for i, field := range fields {
			converted[i] = apitypes.Type{Name: field.Name, Type: field.Type}
		}
		types[name] = converted
	}

	domain := typedData.Domain
	var domainFields []apitypes.Type
	if domain.Name != "" {
		domainFields = append(domainFields, apitypes.Type{Name: "name", Type: "string"})
	}
	if domain.Version != "" {
		domainFields = append(domainFields, apitypes.Type{Name: "version", Type: "string"})
	}
	if domain.ChainID != nil {
		domainFields = append(domainFields, apitypes.Type{Name: "chainId", Type: "uint256"})
	}
	if domain.VerifyingContract != "" {
		domainFields = append(domainFields, apitypes.Type{Name: "verifyingContract", Type: "address"})
	}
	if domain.Salt != "" {
		domainFields = append(domainFields, apitypes.Type{Name: "salt", Type: "bytes32"})
	}
	types["EIP712Domain"] = domainFields

	apiDomain := apitypes.TypedDataDomain{
		Name:              domain.Name,
		Version:           domain.Version,
		VerifyingContract: domain.VerifyingContract,
		Salt:              domain.Salt,
	}
	if domain.ChainID != nil {
		apiDomain.ChainId = (*math.HexOrDecimal256)(domain.ChainID.Int())
	}

	message, ok := normalizeTypedDataValue(typedData.Message).(map[string]any)
	if !ok {
		return apitypes.TypedData{}, errors.New("arcusspot: typed data message must be an object")
	}

	return apitypes.TypedData{
		Types:       types,
		PrimaryType: typedData.PrimaryType,
		Domain:      apiDomain,
		Message:     message,
	}, nil
}

// normalizeTypedDataValue rewrites json.Number leaves as strings, which
// apitypes accepts for every integer width without float precision loss.
func normalizeTypedDataValue(value any) any {
	switch v := value.(type) {
	case json.Number:
		return v.String()
	case map[string]any:
		out := make(map[string]any, len(v))
		for key, item := range v {
			out[key] = normalizeTypedDataValue(item)
		}
		return out
	case []any:
		out := make([]any, len(v))
		for i, item := range v {
			out[i] = normalizeTypedDataValue(item)
		}
		return out
	default:
		return value
	}
}

// QuoteSigningTask names one EIP-712 payload the taker must sign for a quote.
type QuoteSigningTask struct {
	Venue     Venue
	Kind      string // "approval" | "trade"
	TypedData *Eip712TypedData
}

// GetQuoteSigningTasks lists the signatures a firm quote requires. 0x quotes
// may also need an EIP-2612 approval signature.
func GetQuoteSigningTasks(quote FirmQuote) []QuoteSigningTask {
	if zerox, ok := quote.(*ZeroxFirmQuote); ok {
		return zeroxSigningTasks(zerox)
	}
	return []QuoteSigningTask{
		{Venue: quote.FirmQuoteVenue(), Kind: "trade", TypedData: quote.TradeTypedData()},
	}
}

func zeroxSigningTasks(quote *ZeroxFirmQuote) []QuoteSigningTask {
	var tasks []QuoteSigningTask
	if quote.Approval != nil {
		tasks = append(tasks, QuoteSigningTask{
			Venue:     VenueZerox,
			Kind:      "approval",
			TypedData: &quote.Approval.EIP712,
		})
	}
	typedData := quote.TradeTypedData()
	if typedData == nil {
		return tasks
	}
	return append(tasks, QuoteSigningTask{Venue: VenueZerox, Kind: "trade", TypedData: typedData})
}

// SignQuoteOptions tunes SignQuote.
type SignQuoteOptions struct {
	// Taker overrides the taker address; defaults to the taker bound in the
	// quote's witness, then the signer address.
	Taker common.Address
	// Permits optionally folds EIP-2612 permits into the submit body for a
	// first-time sellToken→Permit2 allowance.
	Permits []Permit
	// BuilderFeeBps is Arcus-only. Echo the /quote builderFeeBps onto the
	// submit body so settlement matches the quoted fee plan.
	BuilderFeeBps *int
}

// SignQuote signs a firm quote's trade payload and assembles the venue-specific
// submit body. Bebop quotes are not supported.
func SignQuote(quote FirmQuote, signer TypedDataSigner, options *SignQuoteOptions) (SignedQuote, error) {
	if options == nil {
		options = &SignQuoteOptions{}
	}

	taker := options.Taker
	if taker == (common.Address{}) {
		taker = inferTaker(quote)
	}
	if taker == (common.Address{}) {
		taker = signer.Address()
	}
	if taker == (common.Address{}) {
		return nil, errors.New("arcusspot: unable to infer taker address; set SignQuoteOptions.Taker")
	}

	switch q := quote.(type) {
	case *ZeroxFirmQuote:
		return signZeroxQuote(q, signer, taker)
	case *ArcusFirmQuote:
		return signArcusQuote(q, signer, taker, options)
	case *RialtoFirmQuote:
		return signRialtoQuote(q, signer, taker, options)
	case *LifiFirmQuote:
		return signLifiQuote(q, signer, taker, options)
	default:
		return nil, fmt.Errorf("arcusspot: SignQuote does not support venue %s", quote.FirmQuoteVenue())
	}
}

func signArcusQuote(quote *ArcusFirmQuote, signer TypedDataSigner, taker common.Address, options *SignQuoteOptions) (*ArcusSignedQuote, error) {
	signature, err := signer.SignTypedData(quote.ToSign)
	if err != nil {
		return nil, err
	}
	chainID, err := typedDataChainID(&quote.ToSign)
	if err != nil {
		return nil, err
	}
	return &ArcusSignedQuote{
		Venue:         VenueArcus,
		ChainID:       chainID,
		Taker:         taker,
		TypedData:     quote.ToSign,
		Signature:     signature,
		Permits:       options.Permits,
		BuilderFeeBps: options.BuilderFeeBps,
	}, nil
}

func signZeroxQuote(quote *ZeroxFirmQuote, signer TypedDataSigner, taker common.Address) (*ZeroxSignedQuote, error) {
	typedData := quote.TradeTypedData()
	if typedData == nil {
		return nil, errors.New("arcusspot: 0x quote is missing trade typed data")
	}
	signature, err := signer.SignTypedData(*typedData)
	if err != nil {
		return nil, err
	}
	chainID, err := typedDataChainID(typedData)
	if err != nil {
		return nil, err
	}

	var permits []Permit
	if quote.Approval != nil {
		approvalSig, err := signer.SignTypedData(quote.Approval.EIP712)
		if err != nil {
			return nil, err
		}
		permit, err := permitFromApproval(approvalSig, quote.Approval.EIP712)
		if err != nil {
			return nil, err
		}
		permits = []Permit{permit}
	}

	return &ZeroxSignedQuote{
		Venue:           VenueZerox,
		ChainID:         chainID,
		Taker:           taker,
		TypedData:       *typedData,
		Signature:       signature,
		QuotedAmountIn:  quote.SellAmount,
		QuotedAmountOut: quote.BuyAmount,
		Permits:         permits,
	}, nil
}

func permitFromApproval(signature []byte, typedData Eip712TypedData) (Permit, error) {
	split, err := SplitSignatureBytes(signature)
	if err != nil {
		return Permit{}, err
	}
	token := typedData.Domain.VerifyingContract
	if !common.IsHexAddress(token) {
		return Permit{}, errors.New("arcusspot: EIP-2612 approval missing verifyingContract (token address)")
	}
	value := typedData.Message["value"]
	deadline := typedData.Message["deadline"]
	if value == nil || deadline == nil {
		return Permit{}, errors.New("arcusspot: EIP-2612 approval message missing value/deadline")
	}
	return Permit{
		Token:    common.HexToAddress(token),
		Value:    fmt.Sprint(value),
		Deadline: fmt.Sprint(deadline),
		V:        split.V,
		R:        split.R,
		S:        split.S,
	}, nil
}

func signRialtoQuote(quote *RialtoFirmQuote, signer TypedDataSigner, taker common.Address, options *SignQuoteOptions) (*RialtoSignedQuote, error) {
	signature, err := signer.SignTypedData(quote.ToSign)
	if err != nil {
		return nil, err
	}
	chainID, err := typedDataChainID(&quote.ToSign)
	if err != nil {
		return nil, err
	}
	return &RialtoSignedQuote{
		Venue:           VenueRialto,
		ChainID:         chainID,
		Taker:           taker,
		TypedData:       quote.ToSign,
		Signature:       signature,
		Tx:              quote.Tx,
		Permits:         options.Permits,
		QuotedAmountIn:  quote.SellAmount,
		QuotedAmountOut: quote.BuyAmount,
	}, nil
}

func signLifiQuote(quote *LifiFirmQuote, signer TypedDataSigner, taker common.Address, options *SignQuoteOptions) (*LifiSignedQuote, error) {
	signature, err := signer.SignTypedData(quote.ToSign)
	if err != nil {
		return nil, err
	}
	chainID, err := typedDataChainID(&quote.ToSign)
	if err != nil {
		return nil, err
	}
	return &LifiSignedQuote{
		Venue:           VenueLifi,
		ChainID:         chainID,
		Taker:           taker,
		TypedData:       quote.ToSign,
		Signature:       signature,
		Tx:              quote.Tx,
		Raw:             quote.Raw,
		MinBuyAmount:    quote.MinBuyAmount,
		Permits:         options.Permits,
		QuotedAmountIn:  quote.SellAmount,
		QuotedAmountOut: quote.BuyAmount,
	}, nil
}

// SplitSignatureBytes splits a 65-byte r||s||v signature into SwapShell's
// split representation, normalizing v from {0, 1} to {27, 28}.
func SplitSignatureBytes(signature []byte) (SplitSignature, error) {
	if len(signature) != 65 {
		return SplitSignature{}, fmt.Errorf("arcusspot: expected 65-byte signature, got %d bytes", len(signature))
	}
	rawV := signature[64]
	v := rawV
	if v < 27 {
		v += 27
	}
	if v != 27 && v != 28 {
		return SplitSignature{}, fmt.Errorf("arcusspot: unsupported ECDSA recovery byte: %d", rawV)
	}
	return SplitSignature{
		SignatureType: 2,
		V:             v,
		R:             common.BytesToHash(signature[0:32]),
		S:             common.BytesToHash(signature[32:64]),
	}, nil
}

func typedDataChainID(typedData *Eip712TypedData) (uint64, error) {
	if typedData.Domain.ChainID == nil {
		return 0, errors.New("arcusspot: typed data is missing domain.chainId")
	}
	return typedData.Domain.ChainID.Int().Uint64(), nil
}

// inferTaker mirrors the TS SDK: arcus binds the taker in witness.taker, rialto
// in witness.recipient, 0x in approval.owner or slippageAndActions.recipient,
// and other venues in the top-level owner field.
func inferTaker(quote FirmQuote) common.Address {
	if zerox, ok := quote.(*ZeroxFirmQuote); ok {
		if zerox.Approval != nil {
			if owner := addressAtPath(zerox.Approval.EIP712.Message, "owner"); owner != (common.Address{}) {
				return owner
			}
		}
	}
	typedData := quote.TradeTypedData()
	if typedData == nil {
		return common.Address{}
	}
	message := typedData.Message
	switch quote.FirmQuoteVenue() {
	case VenueArcus:
		return addressAtPath(message, "witness", "taker")
	case VenueRialto:
		return addressAtPath(message, "witness", "recipient")
	default:
		if owner := addressAtPath(message, "owner"); owner != (common.Address{}) {
			return owner
		}
		return addressAtPath(message, "slippageAndActions", "recipient")
	}
}

func addressAtPath(message map[string]any, path ...string) common.Address {
	var current any = message
	for _, key := range path {
		object, ok := current.(map[string]any)
		if !ok {
			return common.Address{}
		}
		current, ok = object[key]
		if !ok {
			return common.Address{}
		}
	}
	text, ok := current.(string)
	if !ok || !common.IsHexAddress(text) {
		return common.Address{}
	}
	return common.HexToAddress(text)
}
