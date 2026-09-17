package arcusspot

import (
	"github.com/ethereum/go-ethereum/common"
)

// Chain IDs of the supported deployments.
const (
	ArbitrumChainID         uint64 = 42161
	RobinhoodMainnetChainID uint64 = 4663
	RobinhoodTestnetChainID uint64 = 46630
)

// Permit2Address is the canonical Permit2 deployment shared by every chain.
var Permit2Address = common.HexToAddress("0x000000000022D473030F116dDEE9F6B43aC78BA3")

// ChainDeployments holds the on-chain deployment addresses for a supported
// chain (see the router contracts README). Optional contracts are the zero
// address when the chain has no such deployment.
type ChainDeployments struct {
	ChainID uint64
	Slug    string
	// DefaultRPCURL is a public RPC when one exists; empty for chains that
	// require a private RPC URL.
	DefaultRPCURL string
	Permit2       common.Address
	SwapShell     common.Address

	ArcusSettlement          common.Address
	ArcusRfqExecutor         common.Address
	ArcusWrappedEscrow       common.Address
	ArcusWrappedExecutor     common.Address
	ArcusWrappedTokenFactory common.Address
	ArcusWrappedTokenBeacon  common.Address
	// RialtoRouter is the rialto venue router (SwapExecuted.router for
	// routeTag "RIALTO").
	RialtoRouter common.Address
	// LifiPermit2Proxy is the LI.FI Permit2Proxy (SwapExecuted.router for
	// routeTag "LIFI").
	LifiPermit2Proxy common.Address
	// ZeroexRouter is the 0x venue router (SwapExecuted.router for routeTag
	// "ZEROEX").
	ZeroexRouter common.Address
}

// ArbitrumDeployments is the Arbitrum One (42161) deployment set.
var ArbitrumDeployments = ChainDeployments{
	ChainID:       ArbitrumChainID,
	Slug:          "arbitrum",
	DefaultRPCURL: "https://arb1.arbitrum.io/rpc",
	Permit2:       Permit2Address,
	SwapShell:     common.HexToAddress("0xF8698CA109583Ea2CBc57EF560d4Be2E0DF349A2"),
	RialtoRouter:  common.HexToAddress("0xDE0bA676a93EcbA8bA2B51dEcc9E37e2198efe0E"),
	ZeroexRouter:  common.HexToAddress("0xfbeCF057d93430a15A936Dd57A7424D4F0A8772b"),
}

// RobinhoodMainnetDeployments is the Robinhood mainnet (4663) deployment set.
// There is no public default RPC for this chain.
var RobinhoodMainnetDeployments = ChainDeployments{
	ChainID:                  RobinhoodMainnetChainID,
	Slug:                     "robinhood-mainnet",
	Permit2:                  Permit2Address,
	SwapShell:                common.HexToAddress("0x4262efBd176F02824af27010bEa218429c33c7E8"),
	ArcusSettlement:          common.HexToAddress("0x006102b16A04c20306A28b652745D3973D7D24fa"),
	ArcusRfqExecutor:         common.HexToAddress("0xf4da3c42D9c9F494d4688A0112a9DB3C9b18a914"),
	ArcusWrappedEscrow:       common.HexToAddress("0x6d56Ab475069B7E93886b3D3F06c5435B87Ba158"),
	ArcusWrappedExecutor:     common.HexToAddress("0x43cF43056C33128329B54F66CA3649CF2975f1A6"),
	ArcusWrappedTokenFactory: common.HexToAddress("0x8bc71aE8EaC8B25F30c2990930Cc3A80E72e169e"),
	ArcusWrappedTokenBeacon:  common.HexToAddress("0x27fEB332759F8d2f351D7fC72D29af37664ffd77"),
	RialtoRouter:             common.HexToAddress("0xC94135b63772b91D79d0A2DaAb2a8801f32359bD"),
	LifiPermit2Proxy:         common.HexToAddress("0x8eABB4E117fB70b346592e013855f6d825F50af1"),
}

// RobinhoodTestnetDeployments is the Robinhood testnet (46630) deployment set.
var RobinhoodTestnetDeployments = ChainDeployments{
	ChainID:                  RobinhoodTestnetChainID,
	Slug:                     "robinhood-testnet",
	DefaultRPCURL:            "https://rpc.testnet.chain.robinhood.com",
	Permit2:                  Permit2Address,
	SwapShell:                common.HexToAddress("0x528B30910B3ef5a615cDC3847F273947dc474519"),
	ArcusSettlement:          common.HexToAddress("0xE8D8b187754D8a5Ca4Ea4E77Cd01506f9332A773"),
	ArcusRfqExecutor:         common.HexToAddress("0x38Cebc5F641d3A0dd39969B0B75937d267dA0D85"),
	ArcusWrappedEscrow:       common.HexToAddress("0x391747585Caebd163D2D0B980B79B0Ba312A5742"),
	ArcusWrappedExecutor:     common.HexToAddress("0x9956eb7C004d51e29a51f1C68be8e198A1DCFA5d"),
	ArcusWrappedTokenFactory: common.HexToAddress("0xF361dD4cd631175648f54B657d44A3128903D92c"),
	ArcusWrappedTokenBeacon:  common.HexToAddress("0xDd70cD7BbE53ac3d67c1959C9De84423f5Bf2bca"),
}

// ChainDeploymentsByID maps chain ID to its bundled deployment set.
var ChainDeploymentsByID = map[uint64]ChainDeployments{
	ArbitrumChainID:         ArbitrumDeployments,
	RobinhoodMainnetChainID: RobinhoodMainnetDeployments,
	RobinhoodTestnetChainID: RobinhoodTestnetDeployments,
}

// GetChainDeployments returns the bundled deployment set for chainID.
func GetChainDeployments(chainID uint64) (ChainDeployments, bool) {
	deployments, ok := ChainDeploymentsByID[chainID]
	return deployments, ok
}

// GetSwapShellAddress returns the SwapShell address for chainID.
func GetSwapShellAddress(chainID uint64) (common.Address, bool) {
	deployments, ok := ChainDeploymentsByID[chainID]
	if !ok {
		return common.Address{}, false
	}
	return deployments.SwapShell, true
}

// GetSettlementSourceAddresses returns every deployed contract that can appear
// as the ERC-20 Transfer.from when a swap delivers the bought token to the
// taker's wallet. All venues custody the buy-side leg and forward it from their
// router contract (the address emitted as SwapExecuted.router), so this set
// lets consumers distinguish swap settlements from genuine inbound transfers
// (e.g. deposits). Compare with common.Address equality (case-insensitive by
// construction).
func GetSettlementSourceAddresses(chainID uint64) []common.Address {
	deployments, ok := ChainDeploymentsByID[chainID]
	if !ok {
		return nil
	}
	candidates := []common.Address{
		deployments.SwapShell,
		deployments.ArcusSettlement,
		deployments.ArcusRfqExecutor,
		deployments.ArcusWrappedEscrow,
		deployments.ArcusWrappedExecutor,
		deployments.RialtoRouter,
		deployments.LifiPermit2Proxy,
		deployments.ZeroexRouter,
	}
	sources := make([]common.Address, 0, len(candidates))
	for _, address := range candidates {
		if address != (common.Address{}) {
			sources = append(sources, address)
		}
	}
	return sources
}
