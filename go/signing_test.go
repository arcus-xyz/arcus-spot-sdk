package arcusspot

import (
	"bytes"
	"encoding/json"
	"math/big"
	"testing"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/common/hexutil"
	"github.com/ethereum/go-ethereum/crypto"
)

// Well-known anvil/hardhat account #0. Never fund on a real chain.
const testPrivateKeyHex = "ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"

func testSigner(t *testing.T) *PrivateKeySigner {
	t.Helper()
	key, err := crypto.HexToECDSA(testPrivateKeyHex)
	if err != nil {
		t.Fatal(err)
	}
	return NewPrivateKeySigner(key)
}

// Mirrors test/signing.test.ts: pads and normalizes a 0/1 recovery byte to 27/28.
func TestSplitSignatureBytes(t *testing.T) {
	signature := append(append(bytes.Repeat([]byte{0x11}, 32), bytes.Repeat([]byte{0x22}, 32)...), 0x01)
	split, err := SplitSignatureBytes(signature)
	if err != nil {
		t.Fatal(err)
	}
	if split.SignatureType != 2 {
		t.Errorf("signatureType: got %d, want 2", split.SignatureType)
	}
	if split.V != 28 {
		t.Errorf("v: got %d, want 28", split.V)
	}
	if split.R != common.HexToHash("0x"+"11"+"11111111111111111111111111111111111111111111111111111111111111") {
		t.Errorf("unexpected r %s", split.R)
	}
	if split.S != common.HexToHash("0x2222222222222222222222222222222222222222222222222222222222222222") {
		t.Errorf("unexpected s %s", split.S)
	}

	if _, err := SplitSignatureBytes(signature[:64]); err == nil {
		t.Error("expected error for 64-byte signature")
	}
	badV := append(append([]byte{}, signature[:64]...), 0x05)
	if _, err := SplitSignatureBytes(badV); err == nil {
		t.Error("expected error for unsupported recovery byte")
	}
}

// lifiTestTypedData mirrors the typed data in test/signing.test.ts, including a
// redundant EIP712Domain entry that the signer must strip and rebuild.
func lifiTestTypedData() Eip712TypedData {
	return Eip712TypedData{
		Domain: TypedDataDomain{
			Name:              "Permit2",
			ChainID:           NewBigIntish(big.NewInt(4663)),
			VerifyingContract: "0x000000000022d473030f116ddee9f6b43ac78ba3",
		},
		Types: map[string][]TypedDataField{
			"EIP712Domain": {
				{Name: "name", Type: "string"},
				{Name: "chainId", Type: "uint256"},
				{Name: "verifyingContract", Type: "address"},
			},
			"PermitWitnessTransferFrom": {
				{Name: "permitted", Type: "TokenPermissions"},
				{Name: "spender", Type: "address"},
				{Name: "nonce", Type: "uint256"},
				{Name: "deadline", Type: "uint256"},
				{Name: "witness", Type: "LiFiCall"},
			},
			"TokenPermissions": {
				{Name: "token", Type: "address"},
				{Name: "amount", Type: "uint256"},
			},
			"LiFiCall": {
				{Name: "diamondAddress", Type: "address"},
				{Name: "diamondCalldataHash", Type: "bytes32"},
			},
		},
		PrimaryType: "PermitWitnessTransferFrom",
		Message: map[string]any{
			"permitted": map[string]any{
				"token":  "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
				"amount": "1000000",
			},
			"spender":  "0x8eABB4E117fB70b346592e013855f6d825F50af1",
			"nonce":    "0",
			"deadline": "9999999999",
			"witness": map[string]any{
				"diamondAddress":      "0xB477751B76CF82d00a686A1232f5fCD772414Af3",
				"diamondCalldataHash": "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			},
		},
	}
}

// Golden vector from viem (scripts/golden-vector.ts): the exact signature the
// TS SDK produces for the same typed data and key.
const lifiGoldenSignature = "0x05df93324406ec972922b268cb441eba12b70a3922db9bae094351288639304e65485a49a2c9b7d6d0df8270938cfe564265469e90d95cfc819f7ad4ae78c0671b"

func TestSignTypedDataMatchesViem(t *testing.T) {
	signer := testSigner(t)
	signature, err := signer.SignTypedData(lifiTestTypedData())
	if err != nil {
		t.Fatal(err)
	}
	if got := hexutil.Encode(signature); got != lifiGoldenSignature {
		t.Fatalf("signature mismatch with viem golden vector:\ngot  %s\nwant %s", got, lifiGoldenSignature)
	}
}

// Mirrors test/signing.test.ts: returns lifi submit shape with tx, raw, and
// minBuyAmount.
func TestSignQuoteLifi(t *testing.T) {
	signer := testSigner(t)
	quote := &LifiFirmQuote{
		Venue:        VenueLifi,
		BuyAmount:    "200",
		SellAmount:   "1000000",
		MinBuyAmount: "198",
		QuoteID:      "q1",
		ToSign:       lifiTestTypedData(),
		Tx: LifiTx{
			Permit2Proxy:    common.HexToAddress("0x8eABB4E117fB70b346592e013855f6d825F50af1"),
			DiamondCalldata: hexutil.MustDecode("0x1234"),
			BuyToken:        common.HexToAddress("0x82af49447d8a07e3bd95bd0d56f35241523fbab1"),
			Value:           "0",
		},
		Raw: json.RawMessage(`{"estimate":{"toAmountMin":"198"}}`),
	}

	signed, err := SignQuote(quote, signer, &SignQuoteOptions{Taker: signer.Address()})
	if err != nil {
		t.Fatal(err)
	}
	lifi, ok := signed.(*LifiSignedQuote)
	if !ok {
		t.Fatalf("expected *LifiSignedQuote, got %T", signed)
	}
	if lifi.ChainID != 4663 {
		t.Errorf("chainId: got %d, want 4663", lifi.ChainID)
	}
	if lifi.Taker != signer.Address() {
		t.Errorf("taker: got %s, want %s", lifi.Taker, signer.Address())
	}
	if hexutil.Encode(lifi.Signature) != lifiGoldenSignature {
		t.Errorf("signature: got %s, want %s", hexutil.Encode(lifi.Signature), lifiGoldenSignature)
	}
	if lifi.MinBuyAmount != "198" {
		t.Errorf("minBuyAmount: got %s, want 198", lifi.MinBuyAmount)
	}
	if lifi.QuotedAmountIn != "1000000" || lifi.QuotedAmountOut != "200" {
		t.Errorf("quoted amounts: got %s/%s, want 1000000/200", lifi.QuotedAmountIn, lifi.QuotedAmountOut)
	}
	if lifi.Tx.Permit2Proxy != quote.Tx.Permit2Proxy ||
		lifi.Tx.BuyToken != quote.Tx.BuyToken ||
		!bytes.Equal(lifi.Tx.DiamondCalldata, quote.Tx.DiamondCalldata) {
		t.Error("tx not echoed back into the signed quote")
	}
	if !bytes.Equal(lifi.Raw, quote.Raw) {
		t.Error("raw not echoed back into the signed quote")
	}
}

func TestSignQuoteInfersArcusTaker(t *testing.T) {
	signer := testSigner(t)
	witnessTaker := "0x00000000000000000000000000000000000000AA"
	quote := &ArcusFirmQuote{
		Venue: VenueArcus,
		ToSign: Eip712TypedData{
			Domain: TypedDataDomain{
				Name:              "Permit2",
				ChainID:           NewBigIntish(big.NewInt(46630)),
				VerifyingContract: Permit2Address.Hex(),
			},
			Types: map[string][]TypedDataField{
				"PermitWitnessTransferFrom": {
					{Name: "spender", Type: "address"},
					{Name: "witness", Type: "TakerIntent"},
				},
				"TakerIntent": {
					{Name: "taker", Type: "address"},
				},
			},
			PrimaryType: "PermitWitnessTransferFrom",
			Message: map[string]any{
				"spender": Permit2Address.Hex(),
				"witness": map[string]any{"taker": witnessTaker},
			},
		},
	}

	signed, err := SignQuote(quote, signer, nil)
	if err != nil {
		t.Fatal(err)
	}
	arcus, ok := signed.(*ArcusSignedQuote)
	if !ok {
		t.Fatalf("expected *ArcusSignedQuote, got %T", signed)
	}
	if arcus.Taker != common.HexToAddress(witnessTaker) {
		t.Errorf("taker: got %s, want witness taker %s", arcus.Taker, witnessTaker)
	}
	if arcus.ChainID != 46630 {
		t.Errorf("chainId: got %d, want 46630", arcus.ChainID)
	}
}

func TestSignQuoteBebop(t *testing.T) {
	signer := testSigner(t)
	typedData := Eip712TypedData{
		Domain: TypedDataDomain{
			Name:              "Permit2",
			ChainID:           NewBigIntish(big.NewInt(4663)),
			VerifyingContract: Permit2Address.Hex(),
		},
		Types: map[string][]TypedDataField{
			"PermitWitnessTransferFrom": {
				{Name: "permitted", Type: "TokenPermissions"},
				{Name: "spender", Type: "address"},
				{Name: "nonce", Type: "uint256"},
				{Name: "deadline", Type: "uint256"},
				{Name: "witness", Type: "BebopRouterOrder"},
			},
			"TokenPermissions": {
				{Name: "token", Type: "address"},
				{Name: "amount", Type: "uint256"},
			},
			"BebopRouterOrder": {
				{Name: "tokensOwner", Type: "address"},
			},
		},
		PrimaryType: "PermitWitnessTransferFrom",
		Message: map[string]any{
			"permitted": map[string]any{
				"token":  "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
				"amount": "1000000",
			},
			"spender":  RobinhoodMainnetDeployments.BebopRouter.Hex(),
			"nonce":    "9",
			"deadline": "9999999999",
			"witness": map[string]any{
				"tokensOwner": signer.Address().Hex(),
			},
		},
	}
	quote := &BebopFirmQuote{
		Venue:        VenueBebop,
		BuyAmount:    "400",
		SellAmount:   "1000000",
		MinBuyAmount: "390",
		QuoteID:      "q1",
		ToSign:       typedData,
		Tx: BebopTx{
			To:            RobinhoodMainnetDeployments.BebopRouter,
			Data:          hexutil.MustDecode("0x1234"),
			Value:         "0",
			OriginAddress: common.Address{},
		},
	}

	signed, err := SignQuote(quote, signer, nil)
	if err != nil {
		t.Fatal(err)
	}
	bebop, ok := signed.(*BebopSignedQuote)
	if !ok {
		t.Fatalf("expected *BebopSignedQuote, got %T", signed)
	}
	if bebop.ChainID != 4663 || bebop.Taker != signer.Address() {
		t.Errorf("unexpected chain/taker: %d/%s", bebop.ChainID, bebop.Taker)
	}
	if len(bebop.Signature) != 65 {
		t.Errorf("signature length: got %d, want 65", len(bebop.Signature))
	}
	if bebop.Tx.To != quote.Tx.To || !bytes.Equal(bebop.Tx.Data, quote.Tx.Data) {
		t.Error("tx not echoed back into the signed quote")
	}
}

func TestTypedDataJSONRoundTrip(t *testing.T) {
	source := []byte(`{"domain":{"name":"Permit2","chainId":4663,"verifyingContract":"0x000000000022d473030f116ddee9f6b43ac78ba3"},"types":{"Permit":[{"name":"owner","type":"address"}]},"primaryType":"Permit","message":{"owner":"0x00000000000000000000000000000000000000aa","value":"115792089237316195423570985008687907853269984665640564039457584007913129639935","expiry":9999999999}}`)
	var typedData Eip712TypedData
	if err := json.Unmarshal(source, &typedData); err != nil {
		t.Fatal(err)
	}
	if typedData.Domain.ChainID.Int().Int64() != 4663 {
		t.Errorf("chainId: got %s, want 4663", typedData.Domain.ChainID.Int())
	}
	encoded, err := json.Marshal(typedData)
	if err != nil {
		t.Fatal(err)
	}
	// Large numeric literals must survive the round trip untouched.
	for _, fragment := range []string{`"chainId":4663`, `"expiry":9999999999`, `115792089237316195423570985008687907853269984665640564039457584007913129639935`} {
		if !bytes.Contains(encoded, []byte(fragment)) {
			t.Errorf("round-tripped JSON missing %s:\n%s", fragment, encoded)
		}
	}
}
