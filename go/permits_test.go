package arcusspot

import (
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"math/big"
	"testing"

	"github.com/ethereum/go-ethereum"
	"github.com/ethereum/go-ethereum/common"
)

// fakeCaller answers eth_call by method selector.
type fakeCaller struct {
	allowance *big.Int
	nonce     *big.Int
	name      string
	// noncesErr simulates a token without EIP-2612 nonces().
	noncesErr error
	// versionErr simulates a token without version() (fallback to "1").
	versionErr error
}

func (f *fakeCaller) CallContract(_ context.Context, call ethereum.CallMsg, _ *big.Int) ([]byte, error) {
	selector := hex.EncodeToString(call.Data[:4])
	method := map[string]string{
		hex.EncodeToString(ERC20PermitABI.Methods["allowance"].ID): "allowance",
		hex.EncodeToString(ERC20PermitABI.Methods["nonces"].ID):    "nonces",
		hex.EncodeToString(ERC20PermitABI.Methods["name"].ID):      "name",
		hex.EncodeToString(ERC20PermitABI.Methods["version"].ID):   "version",
	}[selector]

	switch method {
	case "allowance":
		return ERC20PermitABI.Methods["allowance"].Outputs.Pack(f.allowance)
	case "nonces":
		if f.noncesErr != nil {
			return nil, f.noncesErr
		}
		return ERC20PermitABI.Methods["nonces"].Outputs.Pack(f.nonce)
	case "name":
		return ERC20PermitABI.Methods["name"].Outputs.Pack(f.name)
	case "version":
		if f.versionErr != nil {
			return nil, f.versionErr
		}
		return ERC20PermitABI.Methods["version"].Outputs.Pack("1")
	default:
		return nil, fmt.Errorf("unexpected selector %s", selector)
	}
}

func arcusQuoteForPermitTest(taker common.Address) *ArcusFirmQuote {
	return &ArcusFirmQuote{
		Venue: VenueArcus,
		ToSign: Eip712TypedData{
			Domain: TypedDataDomain{
				Name:              "Permit2",
				ChainID:           NewBigIntish(big.NewInt(46630)),
				VerifyingContract: Permit2Address.Hex(),
			},
			PrimaryType: "PermitWitnessTransferFrom",
			Message: map[string]any{
				"witness": map[string]any{
					"taker":          taker.Hex(),
					"takerSellToken": "0xf64780eAE9CFe162EF38f5224459a014a1007cd5",
					"sellAmount":     "10000000",
				},
			},
		},
	}
}

// Golden vector from viem (scripts/golden-vector.ts): EIP-2612 permit for
// token "Mock USD" (version "1", chain 46630), owner = anvil account #0,
// spender = Permit2, value = MaxUint256, nonce = 5, deadline = 9999999999.
func TestBuildArcusSellTokenPermitMatchesViem(t *testing.T) {
	signer := testSigner(t)
	caller := &fakeCaller{
		allowance:  big.NewInt(0),
		nonce:      big.NewInt(5),
		name:       "Mock USD",
		versionErr: errors.New("execution reverted"),
	}

	permit, err := BuildArcusSellTokenPermitIfNeeded(context.Background(), arcusQuoteForPermitTest(signer.Address()), BuildPermitOptions{
		Caller:   caller,
		Signer:   signer,
		Deadline: big.NewInt(9999999999),
	})
	if err != nil {
		t.Fatal(err)
	}
	if permit == nil {
		t.Fatal("expected a permit, got nil")
	}
	if permit.Token != common.HexToAddress("0xf64780eAE9CFe162EF38f5224459a014a1007cd5") {
		t.Errorf("token: got %s", permit.Token)
	}
	if permit.Value != MaxUint256.String() {
		t.Errorf("value: got %s, want MaxUint256", permit.Value)
	}
	if permit.Deadline != "9999999999" {
		t.Errorf("deadline: got %s", permit.Deadline)
	}
	if permit.V != 27 {
		t.Errorf("v: got %d, want 27", permit.V)
	}
	if permit.R != common.HexToHash("0xaf93d300d7443a54f7dd7e0abe27bb6654c76477893ee7c63fd709b7e3d1b34b") {
		t.Errorf("r mismatch with viem golden vector: %s", permit.R)
	}
	if permit.S != common.HexToHash("0x765b072cc11c628bf7a3768165ec1ea7ea3cd457a82ef3d63553542d19fc47f2") {
		t.Errorf("s mismatch with viem golden vector: %s", permit.S)
	}
}

func TestBuildPermitSkipsWhenAllowanceSuffices(t *testing.T) {
	signer := testSigner(t)
	caller := &fakeCaller{allowance: big.NewInt(10000000), nonce: big.NewInt(0), name: "Mock USD"}

	permit, err := BuildArcusSellTokenPermitIfNeeded(context.Background(), arcusQuoteForPermitTest(signer.Address()), BuildPermitOptions{
		Caller: caller,
		Signer: signer,
	})
	if err != nil {
		t.Fatal(err)
	}
	if permit != nil {
		t.Fatalf("expected nil permit for sufficient allowance, got %+v", permit)
	}
}

func TestBuildBebopPermitUsesWitnessOwner(t *testing.T) {
	signer := testSigner(t)
	token := common.HexToAddress("0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168")
	quote := &BebopFirmQuote{
		Venue: VenueBebop,
		ToSign: Eip712TypedData{
			Domain: TypedDataDomain{ChainID: NewBigIntish(big.NewInt(4663))},
			Message: map[string]any{
				"permitted": map[string]any{"token": token.Hex(), "amount": "1000000"},
				"witness":   map[string]any{"tokensOwner": signer.Address().Hex()},
			},
		},
	}
	caller := &fakeCaller{allowance: big.NewInt(1000000), nonce: big.NewInt(0), name: "Mock USD"}

	permit, err := BuildBebopSellTokenPermitIfNeeded(context.Background(), quote, BuildPermitOptions{
		Caller: caller,
		Signer: signer,
	})
	if err != nil {
		t.Fatal(err)
	}
	if permit != nil {
		t.Fatalf("expected nil permit for sufficient allowance, got %+v", permit)
	}
}

// Mirrors test/permits.test.ts: a reverting nonces() marks the token as
// non-EIP-2612 and surfaces the approve fallback via PermitUnsupportedError.
func TestBuildPermitUnsupportedToken(t *testing.T) {
	signer := testSigner(t)
	caller := &fakeCaller{
		allowance: big.NewInt(7),
		name:      "USDT-like",
		noncesErr: errors.New("execution reverted"),
	}

	_, err := BuildArcusSellTokenPermitIfNeeded(context.Background(), arcusQuoteForPermitTest(signer.Address()), BuildPermitOptions{
		Caller: caller,
		Signer: signer,
	})
	var unsupported *PermitUnsupportedError
	if !errors.As(err, &unsupported) {
		t.Fatalf("expected PermitUnsupportedError, got %v", err)
	}
	if unsupported.Spender != Permit2Address {
		t.Errorf("spender: got %s, want Permit2", unsupported.Spender)
	}
	if unsupported.SellAmount.Cmp(big.NewInt(10000000)) != 0 {
		t.Errorf("sellAmount: got %s, want 10000000", unsupported.SellAmount)
	}
	if unsupported.CurrentAllowance.Cmp(big.NewInt(7)) != 0 {
		t.Errorf("currentAllowance: got %s, want 7", unsupported.CurrentAllowance)
	}
}

// Transport failures must rethrow instead of downgrading to the approve flow.
func TestBuildPermitReThrowsTransportErrors(t *testing.T) {
	signer := testSigner(t)
	caller := &fakeCaller{
		allowance: big.NewInt(0),
		name:      "Mock USD",
		noncesErr: errors.New("429 Too Many Requests"),
	}

	_, err := BuildArcusSellTokenPermitIfNeeded(context.Background(), arcusQuoteForPermitTest(signer.Address()), BuildPermitOptions{
		Caller: caller,
		Signer: signer,
	})
	if err == nil {
		t.Fatal("expected transport error to propagate")
	}
	var unsupported *PermitUnsupportedError
	if errors.As(err, &unsupported) {
		t.Fatalf("transport error must not become PermitUnsupportedError: %v", err)
	}
}
