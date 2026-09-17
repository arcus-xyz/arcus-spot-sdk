# arcus-spot-sdk (Go)

Go SDK for the Arcus spot router server. A direct port of the TypeScript SDK
([`@arcus-xyz/arcus-spot-sdk`](../README.md)): it wraps the router HTTP API and
provides a go-ethereum-based signing flow for firm quotes routed through
SwapShell — **Arcus RFQ**, **Rialto**, **LI.FI**, and **0x Gasless** venues on
Robinhood mainnet (4663) and testnet (46630).

`github.com/ethereum/go-ethereum` is the only dependency.

## Install

```bash
go get github.com/arcus-xyz/arcus-spot-sdk/go
```

```go
import arcusspot "github.com/arcus-xyz/arcus-spot-sdk/go"
```

## Hosted routers

Public router deployments are available — no local setup or API key is needed to
fetch quotes:

| Environment       | Base URL                                   | Chain ID | Venues              |
| ----------------- | ------------------------------------------ | -------- | ------------------- |
| Robinhood mainnet | `https://router.spot.arcus.xyz/v1`         | 4663     | arcus, rialto, lifi |
| Robinhood testnet | `https://router.spot.testnet.arcus.xyz/v1` | 46630    | arcus               |

The client accepts the base URL with or without the `/v1` suffix and calls
`/quote`, `/price`, `/submit`, `/status`, and `/tokens` relative to it;
`Health()` remains unversioned at `/health`.

## Usage

### Robinhood testnet (Arcus)

Quote → optional EIP-2612 permit → sign → submit, mirroring the TS SDK flow.
Default mock trade pair: **mUSDG → mTSLA** (fetch token addresses via
`GetTokenList`).

```go
package main

import (
	"context"
	"errors"
	"fmt"
	"log"

	arcusspot "github.com/arcus-xyz/arcus-spot-sdk/go"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/ethereum/go-ethereum/ethclient"
)

func main() {
	ctx := context.Background()

	client, err := arcusspot.NewSpotRouterClient(arcusspot.ClientOptions{
		BaseURL: "https://router.spot.testnet.arcus.xyz/v1",
	})
	if err != nil {
		log.Fatal(err)
	}

	rpc, err := ethclient.Dial(arcusspot.RobinhoodTestnetDeployments.DefaultRPCURL)
	if err != nil {
		log.Fatal(err)
	}

	key, err := crypto.HexToECDSA("<taker private key hex>")
	if err != nil {
		log.Fatal(err)
	}
	signer := arcusspot.NewPrivateKeySigner(key)

	slippageBps := 50
	quotes, err := client.GetQuote(ctx, arcusspot.QuoteRequest{
		PriceRequest: arcusspot.PriceRequest{
			ChainID:    arcusspot.RobinhoodTestnetChainID,
			SellToken:  "0xf64780eAE9CFe162EF38f5224459a014a1007cd5", // mUSDG
			BuyToken:   "0x01206fc62E2e88df71cE4b591e93Bb203383482B", // mTSLA
			SellAmount: "10000000",
		},
		Taker:       signer.Address(),
		SlippageBps: &slippageBps,
	})
	if err != nil {
		log.Fatal(err)
	}

	var quote *arcusspot.ArcusFirmQuote
	for _, candidate := range quotes.All {
		if arcus, ok := candidate.(*arcusspot.ArcusFirmQuote); ok {
			quote = arcus
			break
		}
	}
	if quote == nil {
		log.Fatal("no Arcus quote")
	}

	// Optional: one-time EIP-2612 permit when the sellToken→Permit2 allowance is
	// missing (returns nil when the allowance is already set). Non-EIP-2612
	// tokens can't permit: PermitUnsupportedError describes the one-time
	// on-chain approve to Permit2 to send instead; retry after it mines.
	permit, err := arcusspot.BuildArcusSellTokenPermitIfNeeded(ctx, quote, arcusspot.BuildPermitOptions{
		Caller: rpc,
		Signer: signer,
	})
	var unsupported *arcusspot.PermitUnsupportedError
	if errors.As(err, &unsupported) {
		// Send approve(unsupported.Spender, arcusspot.MaxUint256) on
		// unsupported.Token with arcusspot.ERC20PermitABI, wait for the
		// receipt, then retry the builder.
		log.Fatal(unsupported)
	} else if err != nil {
		log.Fatal(err)
	}

	options := &arcusspot.SignQuoteOptions{}
	if permit != nil {
		options.Permits = []arcusspot.Permit{*permit}
	}
	signed, err := arcusspot.SignQuote(quote, signer, options)
	if err != nil {
		log.Fatal(err)
	}

	submitted, err := client.SubmitSignedQuote(ctx, signed)
	if err != nil {
		log.Fatal(err)
	}
	fmt.Println(submitted.TxHash, submitted.Status, submitted.OrderID)

	status, err := client.GetStatus(ctx, arcusspot.StatusRequest{
		Venue:   arcusspot.VenueArcus,
		ID:      submitted.TxHash.Hex(),
		ChainID: arcusspot.RobinhoodTestnetChainID,
	})
	if err != nil {
		log.Fatal(err)
	}
	fmt.Println(status.Status)
}
```

`PermitUnsupportedError` also exposes `SellAmount` and `CurrentAllowance` —
USDT-style tokens revert on a nonzero→nonzero approve, so send `approve(0)`
first when `CurrentAllowance` is nonzero. Only contract-shaped failures
(missing/reverting `nonces()`) classify a token as non-EIP-2612; transport
errors are returned as-is so a flaky RPC never downgrades a gasless flow to a
gas-costing tx. The rialto and lifi builders (`BuildRialtoSellTokenPermitIfNeeded`,
`BuildLifiSellTokenPermitIfNeeded`) share the same behavior; the lifi builder
requires `Options.Owner` because its witness does not carry the taker.

### Chain deployments and token list

```go
deployments, ok := arcusspot.GetChainDeployments(arcusspot.RobinhoodTestnetChainID)
// deployments.SwapShell, .ArcusSettlement, .ArcusRfqExecutor,
// .ArcusWrappedTokenFactory, .ArcusWrappedTokenBeacon, ...

swapShell, ok := arcusspot.GetSwapShellAddress(46630)

tokens, err := client.GetTokenList(ctx)
// []TokenInfo{ChainID, Symbol, Name, Address, Decimals, Source, ...}
```

### Wrapped token address prediction

Pure offline CREATE2 derivation mirroring
`WrappedTokenFactory.predictWrappedToken` on-chain — no RPC calls. The address
is well-defined whether or not the wrapped token has been deployed yet, so treat
the result as the canonical address, not proof of deployment.

```go
wrappedTsla, err := arcusspot.PredictWrappedTokenForChain(
	arcusspot.RobinhoodTestnetChainID,
	common.HexToAddress("0x01206fc62E2e88df71cE4b591e93Bb203383482B"), // mTSLA
)

// Explicit factory/beacon form (e.g. a deployment not bundled in the SDK):
wWeek := arcusspot.PredictWrappedToken(arcusspot.PredictWrappedTokenParams{
	WrappedTokenFactory: arcusspot.RobinhoodMainnetDeployments.ArcusWrappedTokenFactory,
	WrappedTokenBeacon:  arcusspot.RobinhoodMainnetDeployments.ArcusWrappedTokenBeacon,
	Underlying:          common.HexToAddress("0xc93a8c440CEa26D7445dF01729f193b27965099f"), // WEEK
})
// => 0x4B17e556568bB02709a50cA67db7F4DBD46E3d17
```

### SwapShell trade history

```go
history, err := arcusspot.GetSwapShellTradeHistory(ctx, arcusspot.SwapShellTradeHistoryRequest{
	Client:    rpc, // *ethclient.Client
	ChainID:   arcusspot.RobinhoodTestnetChainID,
	Taker:     signer.Address(),
	FromBlock: big.NewInt(1_000_000),
})
```

Always bound `FromBlock`/`ToBlock` and paginate — `eth_getLogs` limits vary by
RPC provider and plan.

## Develop

```sh
go build ./...   # compile
go vet ./...     # static checks
go test ./...    # run the test suite
gofmt -l .       # formatting check (CI enforces)
```

The test suite includes golden vectors generated from the TypeScript SDK's viem
signing path (`../scripts/golden-vector.ts`), so both SDKs are verified to
produce byte-identical EIP-712 signatures.

## Releasing

Go modules are published by pushing a git tag — there is no registry upload and
no credential. Because this module lives in the `go/` subdirectory, tags carry
the directory prefix:

```sh
git tag go/v1.0.0
git push arcus go/v1.0.0
```

[`.github/workflows/release-go.yml`](../.github/workflows/release-go.yml) runs
on every `go/v*` tag: it validates the tag format, builds and tests the tagged
module, then requests it from `proxy.golang.org` so the version is indexed in
the checksum database and listed on
[pkg.go.dev](https://pkg.go.dev/github.com/arcus-xyz/arcus-spot-sdk/go).

Module versions are immutable: never move or delete a released tag — fix
forward with a new version. Versions `v2.0.0` and above additionally require the
module path in `go.mod` to gain a `/v2` suffix (Go semantic import versioning);
the release workflow enforces this.
