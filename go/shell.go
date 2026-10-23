package arcusspot

import (
	"context"
	"errors"
	"fmt"
	"math/big"

	"github.com/ethereum/go-ethereum"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
)

// swapShellABIJSON declares SwapShell's SwapExecuted event as emitted by the
// current Robinhood mainnet and testnet implementations, which carry the
// caller's public API-key id.
const swapShellABIJSON = `[
  {"type":"event","name":"SwapExecuted","inputs":[
    {"name":"taker","type":"address","indexed":true},
    {"name":"tokenIn","type":"address","indexed":true},
    {"name":"tokenOut","type":"address","indexed":true},
    {"name":"minAmountOut","type":"uint256","indexed":false},
    {"name":"amountIn","type":"uint256","indexed":false},
    {"name":"quotedAmountIn","type":"uint256","indexed":false},
    {"name":"quotedAmountOut","type":"uint256","indexed":false},
    {"name":"amountOut","type":"uint256","indexed":false},
    {"name":"tokenInBenchmarkPrice","type":"uint256","indexed":false},
    {"name":"tokenOutBenchmarkPrice","type":"uint256","indexed":false},
    {"name":"router","type":"address","indexed":false},
    {"name":"routeTag","type":"bytes32","indexed":false},
    {"name":"apiKeyId","type":"string","indexed":false},
    {"name":"success","type":"bool","indexed":false},
    {"name":"reason","type":"string","indexed":false}
  ]}
]`

// swapShellLegacyABIJSON declares the earlier SwapExecuted shape without
// apiKeyId: logs from SwapShell implementations before that field was added
// (and the Arbitrum deployment).
const swapShellLegacyABIJSON = `[
  {"type":"event","name":"SwapExecuted","inputs":[
    {"name":"taker","type":"address","indexed":true},
    {"name":"tokenIn","type":"address","indexed":true},
    {"name":"tokenOut","type":"address","indexed":true},
    {"name":"minAmountOut","type":"uint256","indexed":false},
    {"name":"amountIn","type":"uint256","indexed":false},
    {"name":"quotedAmountIn","type":"uint256","indexed":false},
    {"name":"quotedAmountOut","type":"uint256","indexed":false},
    {"name":"amountOut","type":"uint256","indexed":false},
    {"name":"tokenInBenchmarkPrice","type":"uint256","indexed":false},
    {"name":"tokenOutBenchmarkPrice","type":"uint256","indexed":false},
    {"name":"router","type":"address","indexed":false},
    {"name":"routeTag","type":"bytes32","indexed":false},
    {"name":"success","type":"bool","indexed":false},
    {"name":"reason","type":"string","indexed":false}
  ]}
]`

// SwapShellABI is the parsed SwapShell event ABI (current event shape).
var SwapShellABI = mustParseABI(swapShellABIJSON)

// SwapShellLegacyABI is the parsed legacy SwapExecuted event ABI.
var SwapShellLegacyABI = mustParseABI(swapShellLegacyABIJSON)

// SwapExecutedEventID is the topic0 of SwapShell's current SwapExecuted event.
var SwapExecutedEventID = SwapShellABI.Events["SwapExecuted"].ID

// SwapExecutedLegacyEventID is the topic0 of the legacy SwapExecuted event.
var SwapExecutedLegacyEventID = SwapShellLegacyABI.Events["SwapExecuted"].ID

// SwapExecutedArgs are the decoded SwapExecuted event arguments.
type SwapExecutedArgs struct {
	Taker                  common.Address
	TokenIn                common.Address
	TokenOut               common.Address
	MinAmountOut           *big.Int
	AmountIn               *big.Int
	QuotedAmountIn         *big.Int
	QuotedAmountOut        *big.Int
	AmountOut              *big.Int
	TokenInBenchmarkPrice  *big.Int
	TokenOutBenchmarkPrice *big.Int
	Router                 common.Address
	RouteTag               common.Hash
	// APIKeyID is the public API-key id; empty on legacy-shape logs.
	APIKeyID string
	Success  bool
	Reason   string
}

// DecodedSwapExecutedLog pairs a raw log with its decoded SwapExecuted args.
type DecodedSwapExecutedLog struct {
	Log  types.Log
	Args SwapExecutedArgs
}

// DecodeSwapExecutedLogs decodes SwapExecuted events from logs. Receipts
// contain logs from every contract touched by the transaction; logs that do
// not match SwapShell's event signature are ignored.
func DecodeSwapExecutedLogs(logs []types.Log) []DecodedSwapExecutedLog {
	decoded := make([]DecodedSwapExecutedLog, 0, len(logs))
	for _, log := range logs {
		args, err := decodeSwapExecutedLog(log)
		if err != nil {
			continue
		}
		decoded = append(decoded, DecodedSwapExecutedLog{Log: log, Args: *args})
	}
	return decoded
}

func decodeSwapExecutedLog(log types.Log) (*SwapExecutedArgs, error) {
	if len(log.Topics) != 4 {
		return nil, errors.New("not a SwapExecuted log")
	}
	var (
		values   []any
		err      error
		apiKeyID string
	)
	switch log.Topics[0] {
	case SwapExecutedEventID:
		values, err = SwapShellABI.Events["SwapExecuted"].Inputs.NonIndexed().Unpack(log.Data)
		if err != nil {
			return nil, err
		}
		if len(values) != 12 {
			return nil, fmt.Errorf("unexpected SwapExecuted data arity %d", len(values))
		}
		apiKeyID = values[9].(string)
		// Drop apiKeyId so the remaining fields line up with the legacy layout.
		values = append(values[:9:9], values[10:]...)
	case SwapExecutedLegacyEventID:
		values, err = SwapShellLegacyABI.Events["SwapExecuted"].Inputs.NonIndexed().Unpack(log.Data)
		if err != nil {
			return nil, err
		}
		if len(values) != 11 {
			return nil, fmt.Errorf("unexpected SwapExecuted data arity %d", len(values))
		}
	default:
		return nil, errors.New("not a SwapExecuted log")
	}
	routeTag, ok := values[8].([32]byte)
	if !ok {
		return nil, fmt.Errorf("unexpected routeTag type %T", values[8])
	}
	return &SwapExecutedArgs{
		Taker:                  common.BytesToAddress(log.Topics[1].Bytes()),
		TokenIn:                common.BytesToAddress(log.Topics[2].Bytes()),
		TokenOut:               common.BytesToAddress(log.Topics[3].Bytes()),
		MinAmountOut:           values[0].(*big.Int),
		AmountIn:               values[1].(*big.Int),
		QuotedAmountIn:         values[2].(*big.Int),
		QuotedAmountOut:        values[3].(*big.Int),
		AmountOut:              values[4].(*big.Int),
		TokenInBenchmarkPrice:  values[5].(*big.Int),
		TokenOutBenchmarkPrice: values[6].(*big.Int),
		Router:                 values[7].(common.Address),
		RouteTag:               common.Hash(routeTag),
		APIKeyID:               apiKeyID,
		Success:                values[9].(bool),
		Reason:                 values[10].(string),
	}, nil
}

// LogFilterer is the eth_getLogs subset of an Ethereum client.
// *ethclient.Client implements it.
type LogFilterer interface {
	FilterLogs(ctx context.Context, query ethereum.FilterQuery) ([]types.Log, error)
}

// SwapShellTradeHistoryRequest parameterizes GetSwapShellTradeHistory.
type SwapShellTradeHistoryRequest struct {
	// Client executes the eth_getLogs query.
	Client LogFilterer
	// SwapShell defaults from the bundled deployments when zero. Pass it
	// explicitly for local/test deployments or a non-default SwapShell.
	SwapShell common.Address
	// ChainID resolves the default SwapShell address when SwapShell is zero.
	ChainID uint64
	Taker   common.Address
	// FromBlock is required: always bound eth_getLogs queries and page through
	// larger histories. Many RPC providers cap log ranges by plan; free tiers
	// may allow only a handful of blocks per request.
	FromBlock *big.Int
	// ToBlock defaults to "latest" when nil. Prefer an explicit end block for
	// repeatable pagination; broad ranges can be rejected by the RPC.
	ToBlock *big.Int
	// TokenIn optionally filters on the sold token.
	TokenIn *common.Address
	// TokenOut optionally filters on the bought token.
	TokenOut *common.Address
}

// GetSwapShellTradeHistory fetches decoded SwapExecuted logs for one taker.
// Callers should pass a narrow FromBlock/ToBlock window and paginate, because
// eth_getLogs limits vary by provider and subscription plan.
func GetSwapShellTradeHistory(ctx context.Context, request SwapShellTradeHistoryRequest) ([]DecodedSwapExecutedLog, error) {
	swapShell := request.SwapShell
	if swapShell == (common.Address{}) {
		resolved, ok := GetSwapShellAddress(request.ChainID)
		if !ok {
			return nil, errors.New("arcusspot: SwapShell address is required for this chain")
		}
		swapShell = resolved
	}

	topics := [][]common.Hash{
		// Match both event shapes; the indexed topics are identical in both.
		{SwapExecutedEventID, SwapExecutedLegacyEventID},
		{addressTopic(request.Taker)},
	}
	if request.TokenIn != nil || request.TokenOut != nil {
		tokenInTopics := []common.Hash{}
		if request.TokenIn != nil {
			tokenInTopics = append(tokenInTopics, addressTopic(*request.TokenIn))
		}
		topics = append(topics, tokenInTopics)
		if request.TokenOut != nil {
			topics = append(topics, []common.Hash{addressTopic(*request.TokenOut)})
		}
	}

	logs, err := request.Client.FilterLogs(ctx, ethereum.FilterQuery{
		Addresses: []common.Address{swapShell},
		FromBlock: request.FromBlock,
		ToBlock:   request.ToBlock,
		Topics:    topics,
	})
	if err != nil {
		return nil, err
	}
	return DecodeSwapExecutedLogs(logs), nil
}

func addressTopic(address common.Address) common.Hash {
	return common.BytesToHash(common.LeftPadBytes(address.Bytes(), 32))
}
