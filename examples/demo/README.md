# Demo UI

Minimal local browser console for exercising `@arcus-xyz/arcus-spot-sdk` against an Arcus spot router server.

## Run

1. From the repo root, run `bun install`.
2. Run `bun run demo`.
3. Open the Vite URL, connect a wallet, fetch quotes, and select the quote to sign.

The hosted router presets (RH mainnet, testnet, Arbitrum) need no setup. To use the **local** preset instead, start a router with `ZEROX_API_KEY`, `RELAYER_PRIVATE_KEY`, and `RPC_URL`.

The router base-URL preset drives the selected chain: the Arbitrum preset selects `42161` (0x), the RH mainnet preset `4663` (Arcus/Rialto/LI.FI), and the testnet/local presets Robinhood testnet `46630` (Arcus). Changing the chain ID re-syncs the SwapShell address and the token presets, defaulting the pair to **USDC → WETH** (Arbitrum), **USDG → WEEK** (RH mainnet `4663`), or **mUSDG → mTSLA** (RH testnet `46630`). The token dropdowns show only tokens for the selected chain and merge `/tokens` from the versioned base URL when available.
