package arcusspot

import (
	"math/big"
	"testing"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
)

// Mirrors test/shell.test.ts: decode quoted amount fields from legacy-shape
// SwapExecuted logs (no apiKeyId).
func TestDecodeSwapExecutedLogs(t *testing.T) {
	shell := common.HexToAddress("0x0000000000000000000000000000000000000001")
	taker := common.HexToAddress("0x0000000000000000000000000000000000000002")
	tokenIn := common.HexToAddress("0x0000000000000000000000000000000000000003")
	tokenOut := common.HexToAddress("0x0000000000000000000000000000000000000004")
	router := common.HexToAddress("0x0000000000000000000000000000000000000005")

	data, err := SwapShellLegacyABI.Events["SwapExecuted"].Inputs.NonIndexed().Pack(
		big.NewInt(98),  // minAmountOut
		big.NewInt(100), // amountIn
		big.NewInt(100), // quotedAmountIn
		big.NewInt(123), // quotedAmountOut
		big.NewInt(120), // amountOut
		big.NewInt(1),   // tokenInBenchmarkPrice
		big.NewInt(2),   // tokenOutBenchmarkPrice
		router,
		[32]byte{},
		true,
		"",
	)
	if err != nil {
		t.Fatal(err)
	}

	decoded := DecodeSwapExecutedLogs([]types.Log{
		{
			Address: shell,
			Data:    data,
			Topics: []common.Hash{
				SwapExecutedLegacyEventID,
				addressTopic(taker),
				addressTopic(tokenIn),
				addressTopic(tokenOut),
			},
		},
		// Unrelated log shapes are ignored, mirroring the TS decoder.
		{Address: shell, Topics: []common.Hash{{}}},
	})

	if len(decoded) != 1 {
		t.Fatalf("expected 1 decoded log, got %d", len(decoded))
	}
	args := decoded[0].Args
	if args.Taker != taker {
		t.Errorf("taker: got %s, want %s", args.Taker, taker)
	}
	if args.QuotedAmountIn.Cmp(big.NewInt(100)) != 0 {
		t.Errorf("quotedAmountIn: got %s, want 100", args.QuotedAmountIn)
	}
	if args.QuotedAmountOut.Cmp(big.NewInt(123)) != 0 {
		t.Errorf("quotedAmountOut: got %s, want 123", args.QuotedAmountOut)
	}
	if args.AmountOut.Cmp(big.NewInt(120)) != 0 {
		t.Errorf("amountOut: got %s, want 120", args.AmountOut)
	}
	if args.Router != router {
		t.Errorf("router: got %s, want %s", args.Router, router)
	}
	if !args.Success {
		t.Error("success: got false, want true")
	}
	if args.APIKeyID != "" {
		t.Errorf("apiKeyId: got %q, want empty for a legacy log", args.APIKeyID)
	}
}

// The Robinhood mainnet and testnet SwapShell implementations emit SwapExecuted
// with a string apiKeyId between routeTag and success.
func TestDecodeSwapExecutedLogsWithAPIKeyID(t *testing.T) {
	want := common.HexToHash("0x824a7dbfc9f746ced98e93f691f8e5c68d0a549b6999eeaa16192f903e39aa27")
	if SwapExecutedEventID != want {
		t.Fatalf("SwapExecutedEventID: got %s, want %s", SwapExecutedEventID, want)
	}

	taker := common.HexToAddress("0x0000000000000000000000000000000000000002")
	router := common.HexToAddress("0x0000000000000000000000000000000000000005")
	data, err := SwapShellABI.Events["SwapExecuted"].Inputs.NonIndexed().Pack(
		big.NewInt(98), big.NewInt(100), big.NewInt(100), big.NewInt(123), big.NewInt(120),
		big.NewInt(1), big.NewInt(2), router, [32]byte{}, "anonymous", true, "",
	)
	if err != nil {
		t.Fatal(err)
	}

	decoded := DecodeSwapExecutedLogs([]types.Log{{
		Data: data,
		Topics: []common.Hash{
			SwapExecutedEventID,
			addressTopic(taker),
			addressTopic(common.HexToAddress("0x0000000000000000000000000000000000000003")),
			addressTopic(common.HexToAddress("0x0000000000000000000000000000000000000004")),
		},
	}})
	if len(decoded) != 1 {
		t.Fatalf("expected 1 decoded log, got %d", len(decoded))
	}
	args := decoded[0].Args
	if args.Taker != taker || args.Router != router {
		t.Errorf("taker/router: got %s/%s", args.Taker, args.Router)
	}
	if args.AmountOut.Cmp(big.NewInt(120)) != 0 {
		t.Errorf("amountOut: got %s, want 120", args.AmountOut)
	}
	if args.APIKeyID != "anonymous" {
		t.Errorf("apiKeyId: got %q, want anonymous", args.APIKeyID)
	}
	if !args.Success || args.Reason != "" {
		t.Errorf("success/reason: got %v/%q", args.Success, args.Reason)
	}
}
