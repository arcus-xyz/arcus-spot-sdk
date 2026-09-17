package arcusspot

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"strings"
	"time"

	"github.com/ethereum/go-ethereum"
	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
)

// MaxUint256 is the default permit/approve amount: unlimited, so the taker
// never re-authorizes the token.
var MaxUint256 = new(big.Int).Sub(new(big.Int).Lsh(big.NewInt(1), 256), big.NewInt(1))

// DefaultPermitTTL is the default EIP-2612 permit deadline horizon.
const DefaultPermitTTL = 30 * time.Minute

// erc20PermitABIJSON covers the minimal ERC-20 + EIP-2612 surface needed to
// build a token→Permit2 permit, plus approve for the non-EIP-2612 fallback tx.
const erc20PermitABIJSON = `[
  {"type":"function","name":"allowance","stateMutability":"view","inputs":[{"name":"owner","type":"address"},{"name":"spender","type":"address"}],"outputs":[{"type":"uint256"}]},
  {"type":"function","name":"name","stateMutability":"view","inputs":[],"outputs":[{"type":"string"}]},
  {"type":"function","name":"nonces","stateMutability":"view","inputs":[{"name":"owner","type":"address"}],"outputs":[{"type":"uint256"}]},
	{"type":"function","name":"version","stateMutability":"view","inputs":[],"outputs":[{"type":"string"}]},
	{"type":"function","name":"DOMAIN_SEPARATOR","stateMutability":"view","inputs":[],"outputs":[{"type":"bytes32"}]},
	{"type":"function","name":"eip712Domain","stateMutability":"view","inputs":[],"outputs":[{"name":"fields","type":"bytes1"},{"name":"name","type":"string"},{"name":"version","type":"string"},{"name":"chainId","type":"uint256"},{"name":"verifyingContract","type":"address"},{"name":"salt","type":"bytes32"},{"name":"extensions","type":"uint256[]"}]},
	{"type":"function","name":"approve","stateMutability":"nonpayable","inputs":[{"name":"spender","type":"address"},{"name":"amount","type":"uint256"}],"outputs":[{"type":"bool"}]}
]`

// ERC20PermitABI is the parsed minimal ERC-20 + EIP-2612 ABI. Use it to send
// the one-time approve(spender, amount) fallback tx described by
// PermitUnsupportedError.
var ERC20PermitABI = mustParseABI(erc20PermitABIJSON)

func mustParseABI(source string) abi.ABI {
	parsed, err := abi.JSON(strings.NewReader(source))
	if err != nil {
		panic(err)
	}
	return parsed
}

// PermitUnsupportedError is returned when the sell token has no EIP-2612
// permit() and the taker's Permit2 allowance is insufficient. Recover by
// sending a one-time on-chain approve(Spender, amount) on Token (use
// ERC20PermitABI / MaxUint256), waiting for the receipt, then retrying the
// builder — the allowance check then passes and it returns nil.
// CurrentAllowance is exposed because USDT-style tokens revert on
// nonzero→nonzero approves (send approve(0) first when it's nonzero).
type PermitUnsupportedError struct {
	// Token is the sell token that can't permit.
	Token common.Address
	// Spender is the approve target — always the canonical Permit2, never a
	// venue router.
	Spender common.Address
	// SellAmount is the minimum allowance the swap needs.
	SellAmount *big.Int
	// CurrentAllowance is the taker's current token→Permit2 allowance.
	CurrentAllowance *big.Int
}

// Error implements error.
func (e *PermitUnsupportedError) Error() string {
	return fmt.Sprintf(
		"token %s has no working EIP-2612 permit; send a one-time approve(%s) tx for at least %s, then retry",
		e.Token, e.Spender, e.SellAmount,
	)
}

// ContractCaller is the read-only subset of an Ethereum client the permit
// builders need. *ethclient.Client implements it.
type ContractCaller interface {
	CallContract(ctx context.Context, call ethereum.CallMsg, blockNumber *big.Int) ([]byte, error)
}

// BuildPermitOptions configures the sell-token permit builders.
type BuildPermitOptions struct {
	// Caller reads allowance / name / nonces / version from the chain.
	Caller ContractCaller
	// Signer signs the EIP-2612 permit; must be the taker / token owner.
	Signer TypedDataSigner
	// Owner overrides the token owner; defaults to the taker bound in the
	// quote's signed witness (required for lifi, which has no witness taker).
	Owner common.Address
	// Value is the permit value. Defaults to MaxUint256 so the taker never
	// re-permits this token.
	Value *big.Int
	// Deadline is the permit deadline (unix seconds). Defaults to
	// now + DefaultPermitTTL.
	Deadline *big.Int
}

// BuildArcusSellTokenPermitIfNeeded builds an EIP-2612 permit for the arcus
// sellToken→Permit2 allowance, but only when it's actually needed. Returns nil
// when the taker has already approved Permit2 for at least sellAmount (no
// signature prompt in that case). Returns PermitUnsupportedError when the token
// has no EIP-2612 permit — the taker must then send the one-time approve tx it
// describes.
func BuildArcusSellTokenPermitIfNeeded(ctx context.Context, quote *ArcusFirmQuote, options BuildPermitOptions) (*Permit, error) {
	message := quote.ToSign.Message
	token := addressAtPath(message, "witness", "takerSellToken")
	owner := options.Owner
	if owner == (common.Address{}) {
		owner = addressAtPath(message, "witness", "taker")
	}
	sellAmount := bigIntAtPath(message, "witness", "sellAmount")
	if token == (common.Address{}) || owner == (common.Address{}) || sellAmount == nil {
		return nil, errors.New("arcusspot: arcus permit: quote.ToSign.Message missing witness token/taker/sellAmount")
	}
	return buildSellTokenPermitIfNeeded(ctx, sellTokenPermitCore{
		Token:      token,
		Owner:      owner,
		SellAmount: sellAmount,
		TypedData:  &quote.ToSign,
		Options:    options,
	})
}

// BuildRialtoSellTokenPermitIfNeeded builds an EIP-2612 permit for the rialto
// sellToken→Permit2 allowance, but only when needed — returns nil when the
// taker has already approved Permit2 for at least sellAmount, and returns
// PermitUnsupportedError for non-EIP-2612 tokens. Folding the returned permit
// into the signed quote makes a first-time taker's swap fully gasless
// (SwapShell applies it before RialtoRouter pulls funds).
func BuildRialtoSellTokenPermitIfNeeded(ctx context.Context, quote *RialtoFirmQuote, options BuildPermitOptions) (*Permit, error) {
	message := quote.ToSign.Message
	token := addressAtPath(message, "permitted", "token")
	owner := options.Owner
	if owner == (common.Address{}) {
		owner = addressAtPath(message, "witness", "recipient")
	}
	amount := bigIntAtPath(message, "permitted", "amount")
	if token == (common.Address{}) || owner == (common.Address{}) || amount == nil {
		return nil, errors.New("arcusspot: rialto permit: quote.ToSign.Message missing permitted/owner")
	}
	return buildSellTokenPermitIfNeeded(ctx, sellTokenPermitCore{
		Token:      token,
		Owner:      owner,
		SellAmount: amount,
		TypedData:  &quote.ToSign,
		Options:    options,
	})
}

// BuildLifiSellTokenPermitIfNeeded builds an EIP-2612 permit for the lifi
// sellToken→Permit2 allowance when needed. Same Permit2 witness shape as
// rialto, but the witness binds LI.FI diamond calldata, so Options.Owner (the
// taker) is required.
func BuildLifiSellTokenPermitIfNeeded(ctx context.Context, quote *LifiFirmQuote, options BuildPermitOptions) (*Permit, error) {
	message := quote.ToSign.Message
	token := addressAtPath(message, "permitted", "token")
	owner := options.Owner
	amount := bigIntAtPath(message, "permitted", "amount")
	if token == (common.Address{}) || owner == (common.Address{}) || amount == nil {
		return nil, errors.New("arcusspot: lifi permit: quote.ToSign.Message missing permitted token/amount or Options.Owner")
	}
	return buildSellTokenPermitIfNeeded(ctx, sellTokenPermitCore{
		Token:      token,
		Owner:      owner,
		SellAmount: amount,
		TypedData:  &quote.ToSign,
		Options:    options,
	})
}

type sellTokenPermitCore struct {
	Token      common.Address
	Owner      common.Address
	SellAmount *big.Int
	TypedData  *Eip712TypedData
	Options    BuildPermitOptions
}

// buildSellTokenPermitIfNeeded is the shared core: it builds and signs the
// EIP-2612 sellToken→Permit2 permit, but only when the taker's Permit2
// allowance doesn't already cover sellAmount (returns nil otherwise — no
// signature prompt).
func buildSellTokenPermitIfNeeded(ctx context.Context, core sellTokenPermitCore) (*Permit, error) {
	caller := core.Options.Caller
	signer := core.Options.Signer
	if caller == nil || signer == nil {
		return nil, errors.New("arcusspot: permit builder requires Options.Caller and Options.Signer")
	}
	if core.TypedData.Domain.ChainID == nil {
		return nil, errors.New("arcusspot: typed data is missing domain.chainId")
	}
	chainID := core.TypedData.Domain.ChainID.Int()

	allowance, err := readUint256(ctx, caller, core.Token, "allowance", core.Owner, Permit2Address)
	if err != nil {
		return nil, err
	}
	if allowance.Cmp(core.SellAmount) >= 0 {
		return nil, nil
	}

	// Probe nonces() before the other reads: its absence means the token isn't
	// EIP-2612 and the taker needs a plain on-chain approve instead. Only
	// contract-shaped failures (revert / zero return data) downgrade the flow;
	// transport errors rethrow so a flaky RPC never turns a gasless flow into a
	// gas-costing approve tx.
	nonce, err := readUint256(ctx, caller, core.Token, "nonces", core.Owner)
	if err != nil {
		if isMissingPermitFunction(err) {
			return nil, &PermitUnsupportedError{
				Token:            core.Token,
				Spender:          Permit2Address,
				SellAmount:       core.SellAmount,
				CurrentAllowance: allowance,
			}
		}
		return nil, err
	}

	value := core.Options.Value
	if value == nil {
		value = MaxUint256
	}
	deadline := core.Options.Deadline
	if deadline == nil {
		deadline = big.NewInt(time.Now().Add(DefaultPermitTTL).Unix())
	}

	name, version, err := readEip2612Domain(ctx, caller, core.Token, chainID)
	if err != nil {
		return nil, err
	}

	typedData := Eip712TypedData{
		Domain: TypedDataDomain{
			Name:              name,
			Version:           version,
			ChainID:           NewBigIntish(chainID),
			VerifyingContract: core.Token.Hex(),
		},
		Types: map[string][]TypedDataField{
			"Permit": {
				{Name: "owner", Type: "address"},
				{Name: "spender", Type: "address"},
				{Name: "value", Type: "uint256"},
				{Name: "nonce", Type: "uint256"},
				{Name: "deadline", Type: "uint256"},
			},
		},
		PrimaryType: "Permit",
		Message: map[string]any{
			"owner":    core.Owner.Hex(),
			"spender":  Permit2Address.Hex(),
			"value":    value.String(),
			"nonce":    nonce.String(),
			"deadline": deadline.String(),
		},
	}

	signature, err := signer.SignTypedData(typedData)
	if err != nil {
		return nil, err
	}
	split, err := SplitSignatureBytes(signature)
	if err != nil {
		return nil, err
	}

	return &Permit{
		Token:    core.Token,
		Value:    value.String(),
		Deadline: deadline.String(),
		V:        split.V,
		R:        split.R,
		S:        split.S,
	}, nil
}

// readEip2612Domain resolves the EIP-712 name+version the token will use in
// permit(). Prefer EIP-5267 eip712Domain(), then keep a version() / "1" / "2"
// candidate only when it matches DOMAIN_SEPARATOR().
func readEip2612Domain(
	ctx context.Context,
	caller ContractCaller,
	token common.Address,
	chainID *big.Int,
) (string, string, error) {
	if values, err := callMethod(ctx, caller, token, "eip712Domain"); err == nil && len(values) >= 3 {
		name, nameOK := values[1].(string)
		version, versionOK := values[2].(string)
		if nameOK && versionOK && name != "" && version != "" {
			return name, version, nil
		}
	}

	name, err := readString(ctx, caller, token, "name")
	if err != nil {
		return "", "", err
	}

	var versionFn string
	if version, err := readString(ctx, caller, token, "version"); err == nil && version != "" {
		versionFn = version
	}

	if onchain, err := readBytes32(ctx, caller, token, "DOMAIN_SEPARATOR"); err == nil {
		candidates := uniqueNonEmpty(versionFn, "1", "2")
		for _, version := range candidates {
			if eip2612DomainSeparator(name, version, chainID, token) == onchain {
				return name, version, nil
			}
		}
	}

	if versionFn == "" {
		versionFn = "1"
	}
	return name, versionFn, nil
}

func uniqueNonEmpty(values ...string) []string {
	seen := make(map[string]struct{}, len(values))
	out := make([]string, 0, len(values))
	for _, value := range values {
		if value == "" {
			continue
		}
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		out = append(out, value)
	}
	return out
}

func eip2612DomainSeparator(name, version string, chainID *big.Int, verifyingContract common.Address) common.Hash {
	bytes32Type, _ := abi.NewType("bytes32", "", nil)
	uint256Type, _ := abi.NewType("uint256", "", nil)
	addressType, _ := abi.NewType("address", "", nil)
	args := abi.Arguments{
		{Type: bytes32Type},
		{Type: bytes32Type},
		{Type: bytes32Type},
		{Type: uint256Type},
		{Type: addressType},
	}
	packed, err := args.Pack(
		eip712DomainTypehash,
		crypto.Keccak256Hash([]byte(name)),
		crypto.Keccak256Hash([]byte(version)),
		chainID,
		verifyingContract,
	)
	if err != nil {
		return common.Hash{}
	}
	return crypto.Keccak256Hash(packed)
}

var eip712DomainTypehash = crypto.Keccak256Hash(
	[]byte("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
)

func readBytes32(ctx context.Context, caller ContractCaller, token common.Address, method string) (common.Hash, error) {
	values, err := callMethod(ctx, caller, token, method)
	if err != nil {
		return common.Hash{}, err
	}
	switch value := values[0].(type) {
	case [32]byte:
		return common.Hash(value), nil
	case common.Hash:
		return value, nil
	default:
		return common.Hash{}, fmt.Errorf("arcusspot: %s returned unexpected type %T", method, values[0])
	}
}

func callMethod(ctx context.Context, caller ContractCaller, token common.Address, method string, args ...any) ([]any, error) {
	input, err := ERC20PermitABI.Pack(method, args...)
	if err != nil {
		return nil, fmt.Errorf("arcusspot: pack %s: %w", method, err)
	}
	output, err := caller.CallContract(ctx, ethereum.CallMsg{To: &token, Data: input}, nil)
	if err != nil {
		return nil, fmt.Errorf("arcusspot: call %s on %s: %w", method, token, err)
	}
	if len(output) == 0 {
		// Mirrors viem's ContractFunctionZeroDataError: the address has no code
		// or the function is missing.
		return nil, fmt.Errorf("arcusspot: call %s on %s: %w", method, token, errZeroCallData)
	}
	values, err := ERC20PermitABI.Unpack(method, output)
	if err != nil {
		return nil, fmt.Errorf("arcusspot: unpack %s: %w", method, err)
	}
	return values, nil
}

var errZeroCallData = errors.New("returned no data")

func readUint256(ctx context.Context, caller ContractCaller, token common.Address, method string, args ...any) (*big.Int, error) {
	values, err := callMethod(ctx, caller, token, method, args...)
	if err != nil {
		return nil, err
	}
	value, ok := values[0].(*big.Int)
	if !ok {
		return nil, fmt.Errorf("arcusspot: %s returned unexpected type %T", method, values[0])
	}
	return value, nil
}

func readString(ctx context.Context, caller ContractCaller, token common.Address, method string) (string, error) {
	values, err := callMethod(ctx, caller, token, method)
	if err != nil {
		return "", err
	}
	value, ok := values[0].(string)
	if !ok {
		return "", fmt.Errorf("arcusspot: %s returned unexpected type %T", method, values[0])
	}
	return value, nil
}

// rpcError matches go-ethereum's rpc.Error without importing the rpc package.
type rpcError interface {
	Error() string
	ErrorCode() int
}

// executionRevertedRPCCode is the JSON-RPC error code for "execution reverted".
const executionRevertedRPCCode = 3

// isMissingPermitFunction distinguishes "token has no EIP-2612 nonces()" (call
// reverted / returned no data) from transient transport failures, mirroring the
// TS SDK: match the execution-reverted RPC code (3), the "execution reverted"
// text, and zero return data. Transport failures (429s, timeouts) match none
// and rethrow.
func isMissingPermitFunction(err error) bool {
	if errors.Is(err, errZeroCallData) {
		return true
	}
	var coded rpcError
	if errors.As(err, &coded) && coded.ErrorCode() == executionRevertedRPCCode {
		return true
	}
	return strings.Contains(strings.ToLower(err.Error()), "execution reverted")
}

func bigIntAtPath(message map[string]any, path ...string) *big.Int {
	var current any = message
	for _, key := range path {
		object, ok := current.(map[string]any)
		if !ok {
			return nil
		}
		current, ok = object[key]
		if !ok {
			return nil
		}
	}
	switch v := current.(type) {
	case string:
		value, ok := new(big.Int).SetString(v, 0)
		if !ok {
			return nil
		}
		return value
	case json.Number:
		value, ok := new(big.Int).SetString(v.String(), 10)
		if !ok {
			return nil
		}
		return value
	default:
		return nil
	}
}
