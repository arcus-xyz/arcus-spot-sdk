import {
  createPublicClient,
  createWalletClient,
  custom,
  formatUnits,
  http,
  parseUnits,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import {
  ARBITRUM_CHAIN_ID,
  ARBITRUM_SWAP_SHELL,
  SpotRouterClient,
  buildArcusSellTokenPermitIfNeeded,
  buildLifiSellTokenPermitIfNeeded,
  buildRialtoSellTokenPermitIfNeeded,
  decodeSwapExecutedLogs,
  erc20ApproveAbi,
  MAX_UINT256,
  PermitUnsupportedError,
  getSwapShellAddress,
  getSwapShellTradeHistory,
  getQuoteSigningTasks,
  ROBINHOOD_MAINNET_CHAIN_ID,
  ROBINHOOD_TESTNET_CHAIN_ID,
  signQuote,
  type FirmQuote,
  type NormalizedPrice,
  type Permit,
  type PriceResponse,
  type QuoteResponse,
  type DecodedSwapExecutedLog,
  type SignedQuote,
  type TokenInfo,
} from "../../../src/index";
import "./style.css";

declare global {
  interface Window {
    ethereum?: {
      request(args: { method: string; params?: unknown[] }): Promise<unknown>;
    };
  }
}

type State = {
  tokens: TokenInfo[];
  publicClient: PublicClient | null;
  walletClient: WalletClient | null;
  account: Hex | null;
  walletChainId: number | null;
  priceResponse: PriceResponse | null;
  quoteResponse: QuoteResponse | null;
  selectedQuote: FirmQuote | null;
  signedQuote: SignedQuote | null;
  submitResponse: unknown;
  statusResponse: unknown;
};

const DEFAULT_ARCUS_INTENT_TTL_SEC = 300;

// Default sell/buy symbols surfaced when the selected chain changes.
const DEFAULT_PAIR_BY_CHAIN_ID: Readonly<Record<number, { sell: string; buy: string }>> = {
  [ARBITRUM_CHAIN_ID]: { sell: "USDC", buy: "WETH" },
  [ROBINHOOD_MAINNET_CHAIN_ID]: { sell: "USDG", buy: "WEEK" },
  [ROBINHOOD_TESTNET_CHAIN_ID]: { sell: "mUSDG", buy: "TSLA" },
};

const state: State = {
  tokens: [],
  publicClient: null,
  walletClient: null,
  account: null,
  walletChainId: null,
  priceResponse: null,
  quoteResponse: null,
  selectedQuote: null,
  signedQuote: null,
  submitResponse: null,
  statusResponse: null,
};

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("Missing #app");

const ROUTER_BASE_URLS = {
  testnet: "https://router.spot.testnet.arcus.xyz/v1",
  arbitrum: "https://router-arbitrum.v5-spot-testing.com/v1",
  rhMainnet: "https://router.spot.arcus.xyz/v1",
  local: "http://localhost:8787/v1",
  custom: "custom",
} as const;

app.innerHTML = `
  <main class="shell">
    <div class="topbar">
      <div class="brand">
        <span class="mark">arcus-spot-sdk / local execution console</span>
        <span id="runStatus" class="pill">idle</span>
      </div>
      <div class="wallet">
        <span id="health" class="pill">router unchecked</span>
        <code id="account">no wallet</code>
        <code id="walletChain">chain ?</code>
      </div>
    </div>
    <div class="grid">
      <aside class="sidebar">
        <section class="section">
          <h2>Step 2 / Token Pair</h2>
          <div class="fields">
            <div class="pair">
              <div class="field">
                <label for="sellPreset">sell preset</label>
                <select id="sellPreset"></select>
              </div>
              <div class="field">
                <label for="buyPreset">buy preset</label>
                <select id="buyPreset"></select>
              </div>
            </div>
            <div class="field">
              <label for="sellToken">sell token</label>
              <input id="sellToken" />
            </div>
            <div class="field">
              <label for="buyToken">buy token</label>
              <input id="buyToken" />
            </div>
            <div class="pair">
              <div class="field">
                <label for="sellDecimals">sell decimals</label>
                <input id="sellDecimals" value="6" />
              </div>
              <div class="field">
                <label for="sellAmount">sell amount</label>
                <input id="sellAmount" value="1" />
              </div>
            </div>
          </div>
        </section>

        <section class="section">
          <h2>Dev Settings</h2>
          <div class="fields">
            <div class="field">
              <label for="baseUrlPreset">router base URL</label>
              <select id="baseUrlPreset">
                <option value="${ROUTER_BASE_URLS.rhMainnet}">${ROUTER_BASE_URLS.rhMainnet}</option>
                <option value="${ROUTER_BASE_URLS.testnet}">${ROUTER_BASE_URLS.testnet}</option>
                <option value="${ROUTER_BASE_URLS.arbitrum}">${ROUTER_BASE_URLS.arbitrum}</option>
                <option value="${ROUTER_BASE_URLS.local}">${ROUTER_BASE_URLS.local}</option>
                <option value="${ROUTER_BASE_URLS.custom}">custom</option>
              </select>
              <input id="baseUrl" class="hidden" placeholder="https://router.example.com/v1" />
            </div>
            <div class="field">
              <label for="apiKey">API key (optional)</label>
              <input id="apiKey" type="password" autocomplete="off" spellcheck="false" placeholder="arc_…" />
              <p class="note">Sent as X-Api-Key on every request. Leave empty to call without a key (monitor mode logs anonymous callers).</p>
            </div>
            <div class="pair">
              <div class="field">
                <label for="chainId">chain ID</label>
                <input id="chainId" value="${ROBINHOOD_MAINNET_CHAIN_ID}" />
              </div>
            </div>
            <div class="field">
              <label for="taker">taker</label>
              <input id="taker" placeholder="0x..." />
            </div>
            <div class="field">
              <label for="preferredVenue">force venue (dev)</label>
              <select id="preferredVenue">
                <option value="">auto (router recommended)</option>
                <option value="lifi">lifi</option>
                <option value="arcus">arcus</option>
                <option value="rialto">rialto</option>
              </select>
            </div>
            <div class="field">
              <label for="slippageBps">slippage bps</label>
              <input id="slippageBps" value="50" />
            </div>
            <div class="field">
              <label for="intentTtlSec">arcus intent TTL (s)</label>
              <input id="intentTtlSec" value="${DEFAULT_ARCUS_INTENT_TTL_SEC}" />
            </div>
            <div class="field">
              <label for="allowWrapped">
                <input type="checkbox" id="allowWrapped" />
                allow wrapped (arcus) — accept a synthetic backed by the locked sell token
              </label>
            </div>
          </div>
        </section>

        <section class="section utility-section">
          <h2>Utilities</h2>
          <div class="fields">
            <button id="checkHealth">GET /health</button>
            <button id="loadTokens">GET /tokens</button>
            <button id="fetchPrice">GET /price</button>
            <p class="note">All swaps execute through SwapShell with relayer-paid gas. RH mainnet (4663) fans out to arcus, rialto, and lifi — use "force venue" to pin lifi for testing.</p>
            <div class="utility-output">
              <div class="mini-header">
                <label>Raw utility response</label>
                <button class="copy-button" data-copy-target="utilityOut">Copy</button>
              </div>
              <div id="utilityOut" class="json-viewer">{}</div>
            </div>
          </div>
        </section>

        <section class="section">
          <h2>Logs Lookup</h2>
          <div class="fields">
            <div class="field">
              <label for="logsRpcUrl">RPC URL</label>
              <input id="logsRpcUrl" placeholder="https://arb-mainnet.g.alchemy.com/v2/..." />
            </div>
            <div class="field">
              <label for="swapShell">SwapShell address</label>
              <input id="swapShell" value="${ARBITRUM_SWAP_SHELL}" />
            </div>
            <div class="field">
              <label for="logsTaker">taker</label>
              <input id="logsTaker" placeholder="0x user address" />
            </div>
            <div class="pair">
              <div class="field">
                <label for="logsFromBlock">from block</label>
                <input id="logsFromBlock" placeholder="0x1BBB345D" />
              </div>
              <div class="field">
                <label for="logsToBlock">to block</label>
                <input id="logsToBlock" placeholder="0x1BBB345F" />
              </div>
            </div>
            <div class="pair">
              <div class="field">
                <label for="logsTokenIn">tokenIn filter</label>
                <input id="logsTokenIn" placeholder="optional 0x..." />
              </div>
              <div class="field">
                <label for="logsTokenOut">tokenOut filter</label>
                <input id="logsTokenOut" placeholder="optional 0x..." />
              </div>
            </div>
            <button id="lookupLogs">Lookup SwapExecuted logs</button>
            <p class="note">Uses eth_getLogs through viem; keep ranges small on free RPC plans.</p>
          </div>
        </section>
      </aside>

      <section class="workspace">
        <div class="actions workflow">
          <div class="step">
            <span>1</span>
            <button id="connect">Connect Wallet</button>
          </div>
          <div class="step">
            <span>2</span>
            <strong>Select tokens</strong>
            <small>Use the sidebar pair form</small>
          </div>
          <div class="step">
            <span>3</span>
            <button id="fetchQuote">GET /quote</button>
          </div>
          <label class="step quote-picker" for="quoteSelect">
            <span>4</span>
            <strong>Select quote</strong>
            <select id="quoteSelect" disabled>
              <option value="">fetch quotes first</option>
            </select>
          </label>
          <div class="step">
            <span>5</span>
            <button id="sign" disabled>Sign</button>
          </div>
          <div class="step">
            <span>6</span>
            <button id="submit" disabled>Submit</button>
          </div>
          <div class="step">
            <span>7</span>
            <button id="poll" disabled>Poll Status</button>
          </div>
        </div>
        <div class="panels">
          <div class="quote-stack">
            <article class="panel">
              <div class="panel-header">
                <h3>Quote Request</h3>
                <button class="copy-button" data-copy-target="quoteRequestOut">Copy</button>
              </div>
              <div id="quoteRequestOut" class="json-viewer">{}</div>
            </article>
            <article class="panel">
              <div class="panel-header">
                <h3>Calculated Details</h3>
                <button class="copy-button" data-copy-target="quoteDetailsOut">Copy</button>
              </div>
              <div id="quoteDetailsOut" class="details-output">Fetch a quote to see the selected venue, human-readable amounts, and signing tasks.</div>
            </article>
            <article class="panel">
              <div class="panel-header">
                <h3>Quote Response</h3>
                <button class="copy-button" data-copy-target="quoteResponseOut">Copy</button>
              </div>
              <div id="quoteResponseOut" class="json-viewer">{}</div>
            </article>
          </div>
          <article class="panel">
            <div class="panel-header">
              <h3>Signed Payload</h3>
              <button class="copy-button" data-copy-target="signedOut">Copy</button>
            </div>
            <div id="signedOut" class="json-viewer">{}</div>
          </article>
          <article class="panel">
            <div class="panel-header">
              <h3>Status</h3>
              <button class="copy-button" data-copy-target="statusOut">Copy</button>
            </div>
            <div id="statusOut" class="json-viewer">{}</div>
          </article>
          <article class="panel">
            <div class="panel-header">
              <h3>Logs</h3>
              <button class="copy-button" data-copy-target="logsOut">Copy</button>
            </div>
            <div id="logsOut" class="json-viewer">{}</div>
          </article>
        </div>
      </section>
    </div>
  </main>
`;

const els = {
  account: must<HTMLElement>("account"),
  apiKey: must<HTMLInputElement>("apiKey"),
  baseUrl: must<HTMLInputElement>("baseUrl"),
  baseUrlPreset: must<HTMLSelectElement>("baseUrlPreset"),
  buyPreset: must<HTMLSelectElement>("buyPreset"),
  buyToken: must<HTMLInputElement>("buyToken"),
  chainId: must<HTMLInputElement>("chainId"),
  health: must<HTMLElement>("health"),
  logsFromBlock: must<HTMLInputElement>("logsFromBlock"),
  logsOut: must<HTMLElement>("logsOut"),
  logsRpcUrl: must<HTMLInputElement>("logsRpcUrl"),
  logsTaker: must<HTMLInputElement>("logsTaker"),
  logsToBlock: must<HTMLInputElement>("logsToBlock"),
  logsTokenIn: must<HTMLInputElement>("logsTokenIn"),
  logsTokenOut: must<HTMLInputElement>("logsTokenOut"),
  quoteDetailsOut: must<HTMLElement>("quoteDetailsOut"),
  quoteRequestOut: must<HTMLElement>("quoteRequestOut"),
  quoteResponseOut: must<HTMLElement>("quoteResponseOut"),
  quoteSelect: must<HTMLSelectElement>("quoteSelect"),
  runStatus: must<HTMLElement>("runStatus"),
  sellAmount: must<HTMLInputElement>("sellAmount"),
  sellDecimals: must<HTMLInputElement>("sellDecimals"),
  sellPreset: must<HTMLSelectElement>("sellPreset"),
  sellToken: must<HTMLInputElement>("sellToken"),
  signedOut: must<HTMLElement>("signedOut"),
  slippageBps: must<HTMLInputElement>("slippageBps"),
  intentTtlSec: must<HTMLInputElement>("intentTtlSec"),
  allowWrapped: must<HTMLInputElement>("allowWrapped"),
  statusOut: must<HTMLElement>("statusOut"),
  swapShell: must<HTMLInputElement>("swapShell"),
  taker: must<HTMLInputElement>("taker"),
  utilityOut: must<HTMLElement>("utilityOut"),
  walletChain: must<HTMLElement>("walletChain"),
  sign: must<HTMLButtonElement>("sign"),
  submit: must<HTMLButtonElement>("submit"),
  poll: must<HTMLButtonElement>("poll"),
  preferredVenue: must<HTMLSelectElement>("preferredVenue"),
};

renderBaseUrlInput();
renderTokenOptions();
void runAction("load tokens", () => loadServerTokens(false), { quiet: true });

must<HTMLButtonElement>("connect").addEventListener(
  "click",
  () => void runAction("connect wallet", connectWallet),
);
must<HTMLButtonElement>("checkHealth").addEventListener(
  "click",
  () => void runAction("health", checkHealth, { utility: true }),
);
must<HTMLButtonElement>("loadTokens").addEventListener(
  "click",
  () =>
    void runAction("load tokens", () => loadServerTokens(true), {
      utility: true,
    }),
);
must<HTMLButtonElement>("fetchPrice").addEventListener(
  "click",
  () => void runAction("price", fetchPrice, { utility: true }),
);
must<HTMLButtonElement>("fetchQuote").addEventListener(
  "click",
  () => void runAction("firm quote", fetchQuote),
);
must<HTMLButtonElement>("lookupLogs").addEventListener(
  "click",
  () => void runAction("logs lookup", lookupTradeHistory),
);
els.sign.addEventListener("click", () => void runAction("sign", signCurrentQuote));
els.submit.addEventListener("click", () => void runAction("submit", submitCurrentQuote));
els.poll.addEventListener("click", () => void runAction("poll status", pollStatus));
els.sellPreset.addEventListener("change", () => applyPreset("sell"));
els.buyPreset.addEventListener("change", () => applyPreset("buy"));
els.quoteSelect.addEventListener("change", selectCurrentQuote);
els.baseUrlPreset.addEventListener("change", renderBaseUrlInput);
els.chainId.addEventListener("change", syncSwapShellForChain);
document.querySelectorAll<HTMLButtonElement>("[data-copy-target]").forEach((button) => {
  button.addEventListener("click", () => void copyOutput(button));
});

function client(): SpotRouterClient {
  const apiKey = els.apiKey.value.trim();
  return new SpotRouterClient({
    baseUrl: routerBaseUrl(),
    timeoutMs: 90_000,
    ...(apiKey ? { apiKey } : {}),
  });
}

function routerBaseUrl(): string {
  const preset = els.baseUrlPreset.value;
  const baseUrl = preset === ROUTER_BASE_URLS.custom ? els.baseUrl.value.trim() : preset;
  if (!baseUrl) throw new Error("router base URL is required");
  return baseUrl;
}

function renderBaseUrlInput(): void {
  const preset = els.baseUrlPreset.value;
  const isCustom = preset === ROUTER_BASE_URLS.custom;
  els.baseUrl.classList.toggle("hidden", !isCustom);
  els.baseUrl.disabled = !isCustom;
  if (isCustom) els.baseUrl.focus();

  if (preset === ROUTER_BASE_URLS.arbitrum) {
    els.chainId.value = String(ARBITRUM_CHAIN_ID);
  } else if (preset === ROUTER_BASE_URLS.rhMainnet) {
    els.chainId.value = String(ROBINHOOD_MAINNET_CHAIN_ID);
  } else if (preset === ROUTER_BASE_URLS.testnet || preset === ROUTER_BASE_URLS.local) {
    els.chainId.value = String(ROBINHOOD_TESTNET_CHAIN_ID);
  }
  syncSwapShellForChain();
}

function syncSwapShellForChain(): void {
  const swapShell = getSwapShellAddress(chainId());
  if (swapShell) els.swapShell.value = swapShell;
  renderTokenOptions();
}

async function connectWallet(): Promise<void> {
  const provider = window.ethereum;
  if (!provider) {
    setStatus("no injected wallet", "error");
    return;
  }

  const accounts = (await provider.request({
    method: "eth_requestAccounts",
  })) as Hex[];
  const walletChainId = await currentWalletChainId();
  const account = accounts[0];
  if (!account) throw new Error("No wallet account returned");

  state.account = account;
  state.walletChainId = walletChainId;
  state.publicClient = createPublicClient({ transport: custom(provider) });
  state.walletClient = createWalletClient({
    account,
    transport: custom(provider),
  });
  els.taker.value = account;
  els.logsTaker.value = account;
  els.account.textContent = shorten(account);
  els.walletChain.textContent = `chain ${walletChainId}`;
  setStatus("wallet connected");
}

async function checkHealth(): Promise<void> {
  const health = await client().health();
  els.health.textContent = `router ok / chain ${health.chainId}`;
  setJson(els.utilityOut, { route: "GET /health", response: health });
  assertExpectedChain(health.chainId, "router");
  setStatus("health ok");
}

async function loadServerTokens(report: boolean): Promise<void> {
  try {
    const serverTokens = await client().getTokenList();
    state.tokens = serverTokens;
    renderTokenOptions();
    setJson(els.utilityOut, {
      route: "GET /tokens",
      response: serverTokens,
    });
    if (report) setStatus(`loaded ${serverTokens.length} server tokens`);
  } catch (error) {
    setJson(els.utilityOut, {
      route: "GET /tokens",
      error: errorDetails(error),
      timestamp: new Date().toISOString(),
    });
    if (report) setStatus(errorMessage(error), "error");
  }
}

async function fetchPrice(): Promise<void> {
  await ensureRouterChain();
  const request = priceInputs();
  setJson(els.quoteRequestOut, {
    route: "GET /price",
    query: request,
  });
  const priceResponse = await client().getPrice(request);
  state.priceResponse = priceResponse;
  const selectedPrice = recommendedPrice(priceResponse);
  setDetails(els.quoteDetailsOut, [
    `Recommended venue: ${priceResponse.recommended}`,
    `Selected price: ${selectedPrice ? formatAmountSummary(priceSummary(selectedPrice)) : "none"}`,
    `Available venues: ${priceResponse.all.map((price) => price.venue).join(", ") || "none"}`,
    `Errors: ${priceResponse.errors?.length ?? 0}`,
  ]);
  setJson(els.quoteResponseOut, priceResponse);
  setJson(els.utilityOut, {
    route: "GET /price",
    selected: selectedPrice ? priceSummary(selectedPrice) : null,
    response: priceResponse,
  });
  setStatus(`best price: ${priceResponse.recommended}`);
}

async function fetchQuote(): Promise<void> {
  await ensureRouterChain();
  const request = quoteInputs();
  setJson(els.quoteRequestOut, { route: "GET /quote", query: request });
  const quoteResponse = await client().getQuote(request);
  state.quoteResponse = quoteResponse;
  state.selectedQuote = selectQuote(quoteResponse);
  state.signedQuote = null;
  state.submitResponse = null;
  state.statusResponse = null;
  els.sign.disabled = !state.selectedQuote;
  els.submit.disabled = true;
  els.poll.disabled = true;
  renderQuoteOptions();

  renderQuoteDetails(state.selectedQuote);
  setJson(els.quoteResponseOut, quoteResponse);
  setJson(els.signedOut, {});
  setJson(els.statusOut, {});
  setStatus(`loaded ${quoteResponse.all.length} quote(s), selected ${state.selectedQuote?.venue}`);
}

// Build the one-time sellToken→Permit2 permit for venues that settle via
// SwapShell. Undefined when the allowance is already set (or the venue doesn't
// need one); throws PermitUnsupportedError for non-EIP-2612 tokens.
async function buildSellTokenPermit(
  quote: FirmQuote,
  publicClient: PublicClient,
  walletClient: WalletClient,
): Promise<Permit | undefined> {
  const common = { publicClient, walletClient, taker: taker() };
  if (quote.venue === "arcus") return buildArcusSellTokenPermitIfNeeded({ quote, ...common });
  if (quote.venue === "rialto") return buildRialtoSellTokenPermitIfNeeded({ quote, ...common });
  if (quote.venue === "lifi") return buildLifiSellTokenPermitIfNeeded({ quote, ...common });
  return undefined;
}

async function signCurrentQuote(): Promise<void> {
  if (!state.selectedQuote) throw new Error("Fetch and select a firm quote first");
  if (!state.walletClient) await connectWallet();
  if (!state.walletClient) throw new Error("Wallet client unavailable");
  await ensureWalletChain();

  // One-time sellToken→Permit2 permit for venues that settle via SwapShell, so
  // the first swap stays gasless. Non-EIP-2612 tokens can't permit: send a single
  // on-chain approve to Permit2 instead, then retry (allowance now set).
  let permit: Permit | undefined;
  if (state.publicClient) {
    const { publicClient, walletClient, selectedQuote } = state;
    try {
      permit = await buildSellTokenPermit(selectedQuote, publicClient, walletClient);
    } catch (error) {
      if (!(error instanceof PermitUnsupportedError)) throw error;
      setStatus("sell token lacks EIP-2612 — sending one-time approve to Permit2…");
      const hash = await walletClient.writeContract({
        address: error.token,
        abi: erc20ApproveAbi,
        functionName: "approve",
        args: [error.spender, MAX_UINT256],
        account: walletClient.account ?? taker(),
        chain: null,
      });
      await publicClient.waitForTransactionReceipt({ hash });
      // Retry re-reads the allowance on-chain rather than trusting the receipt.
      permit = await buildSellTokenPermit(selectedQuote, publicClient, walletClient);
    }
  }
  const permits: Permit[] | undefined = permit ? [permit] : undefined;

  if (state.selectedQuote.venue === "arcus") {
    const ttlSec = arcusIntentTtlSec();
    const deadline = String(Math.floor(Date.now() / 1000) + ttlSec);
    state.selectedQuote.toSign.message.deadline = deadline;
    state.selectedQuote.toSign.message.witness.deadline = deadline;
  }

  const signed = await signQuote(state.selectedQuote, state.walletClient, {
    taker: taker(),
    ...(permits ? { permits } : {}),
  });
  state.signedQuote = signed;
  els.submit.disabled = false;
  setJson(els.signedOut, signed);

  // Surface the gasless-approval branch so it's clear when the EIP-2612 permit
  // got folded in (vs. when the wallet already had Permit2 allowance set).
  const permitCount = signed.permits?.length ?? 0;
  setStatus(
    `signed ${state.selectedQuote.venue} quote` +
      (permitCount > 0
        ? ` (folded ${permitCount} EIP-2612 permit)`
        : " (no permit — Permit2 allowance already set)"),
  );
}

async function submitCurrentQuote(): Promise<void> {
  if (!state.signedQuote) throw new Error("Sign the quote first");
  await ensureRouterChain();
  const response = await client().submitSignedQuote(state.signedQuote);
  state.submitResponse = response;
  els.poll.disabled = false;
  setJson(els.statusOut, { submitResponse: response });

  const wrapped = objectValue(response, ["wrapped"]) === true;
  const orderId = objectValue(response, ["orderId"]);
  setStatus(
    wrapped && typeof orderId === "string"
      ? `submitted (wrapped fill — orderId ${orderId} awaiting maker settle)`
      : "submitted",
  );
}

async function pollStatus(): Promise<void> {
  if (!state.signedQuote) throw new Error("Submit a signed quote first");
  await ensureRouterChain();
  const txHash = extractTxHash(state.submitResponse);

  const response = await client().getStatus({
    venue: state.signedQuote.venue,
    chainId: chainId(),
    id: txHash,
  });
  const swapExecutedLogs =
    response.status === "confirmed" ? await confirmedSwapExecutedLogs(txHash) : [];
  state.statusResponse = response;
  setJson(els.statusOut, {
    submitResponse: state.submitResponse,
    statusResponse: response,
    swapExecutedLogs,
    slippage: realizedSlippageSummaries(swapExecutedLogs),
  });
  setStatus(`status: ${response.status}`);
}

async function lookupTradeHistory(): Promise<void> {
  const publicClient = logsPublicClient();

  const request: {
    swapShell: Hex;
    chainId: number;
    taker: Hex;
    fromBlock: bigint;
    toBlock: bigint;
    tokenIn?: Hex;
    tokenOut?: Hex;
  } = {
    swapShell: addressInput(els.swapShell.value, "SwapShell address"),
    chainId: chainId(),
    taker: logsTaker(),
    fromBlock: blockInput(els.logsFromBlock.value, "from block"),
    toBlock: blockInput(els.logsToBlock.value, "to block"),
  };
  const tokenIn = optionalAddressInput(els.logsTokenIn.value, "tokenIn");
  const tokenOut = optionalAddressInput(els.logsTokenOut.value, "tokenOut");
  if (tokenIn) request.tokenIn = tokenIn;
  if (tokenOut) request.tokenOut = tokenOut;

  const logs = await getSwapShellTradeHistory({
    publicClient,
    ...request,
  });

  setJson(els.logsOut, {
    request,
    count: logs.length,
    logs: logs.map((log) => ({
      ...log,
      routeTagText: bytes32ToText(log.args.routeTag),
    })),
  });
  setStatus(`logs: ${logs.length} SwapExecuted event(s)`);
}

function logsPublicClient(): PublicClient {
  const rpcUrl = els.logsRpcUrl.value.trim();
  if (rpcUrl) return createPublicClient({ transport: http(rpcUrl) });
  if (state.publicClient) return state.publicClient;
  throw new Error("Enter an RPC URL or connect a wallet first");
}

async function confirmedSwapExecutedLogs(txHash: Hex) {
  if (!state.publicClient) return [];
  const receipt = await state.publicClient.getTransactionReceipt({
    hash: txHash,
  });
  return decodeSwapExecutedLogs(receipt.logs);
}

function realizedSlippageSummaries(logs: DecodedSwapExecutedLog[]) {
  const maxSlippageBps = Number(els.slippageBps.value);
  return logs.map((log) => {
    const actualOut = log.args.amountOut;
    const minOut = log.args.minAmountOut;
    const outputSurplus = actualOut - minOut;

    return {
      formula: "outputSurplus = amountOut - minAmountOut",
      minAmountOut: minOut,
      amountOut: actualOut,
      outputSurplus,
      maxSlippageBps,
      metMinOut: actualOut >= minOut,
      success: log.args.success,
      reason: log.args.reason,
    };
  });
}

function quoteInputs() {
  return {
    ...priceInputs(),
    taker: taker(),
    slippageBps: Number(els.slippageBps.value),
    allowWrapped: els.allowWrapped.checked,
  };
}

function priceInputs() {
  const decimals = Number(els.sellDecimals.value);
  const amount = parseUnits(els.sellAmount.value, decimals).toString();
  return {
    chainId: chainId(),
    sellToken: els.sellToken.value.trim(),
    buyToken: els.buyToken.value.trim(),
    sellAmount: amount,
  };
}

function selectQuote(response: QuoteResponse): FirmQuote | null {
  const forced = els.preferredVenue.value.trim();
  if (forced) {
    const pinned = response.all.find((quote) => quote.venue === forced);
    if (pinned) return pinned;
    if (response.errors?.some((error) => error.venue === forced)) {
      throw new Error(
        `forced venue ${forced} failed: ${
          response.errors.find((error) => error.venue === forced)?.error.message ?? "unknown"
        }`,
      );
    }
    throw new Error(
      `forced venue ${forced} not returned (available: ${response.all.map((q) => q.venue).join(", ") || "none"})`,
    );
  }
  return recommendedQuote(response);
}

function recommendedQuote(response: QuoteResponse): FirmQuote | null {
  return (
    response.all.find((quote) => quote.venue === response.recommended) ?? response.all[0] ?? null
  );
}

function recommendedPrice(response: PriceResponse): NormalizedPrice | null {
  return (
    response.all.find((price) => price.venue === response.recommended) ?? response.all[0] ?? null
  );
}

function chainId(): number {
  const value = Number(els.chainId.value);
  if (!Number.isInteger(value) || value <= 0)
    throw new Error("chain ID must be a positive integer");
  return value;
}

// Non-throwing variant for UI rendering, where the chain field may be mid-edit.
function currentChainIdOrNull(): number | null {
  const value = Number(els.chainId.value);
  return Number.isInteger(value) && value > 0 ? value : null;
}

function taker(): Hex {
  const value = els.taker.value.trim();
  return addressInput(value, "taker");
}

function arcusIntentTtlSec(): number {
  const value = Number(els.intentTtlSec.value);
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_ARCUS_INTENT_TTL_SEC;
}

function logsTaker(): Hex {
  const value = els.logsTaker.value.trim() || els.taker.value.trim();
  return addressInput(value, "logs taker");
}

function addressInput(value: string, label: string): Hex {
  const trimmed = value.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(trimmed)) throw new Error(`${label} must be a 0x address`);
  return trimmed as Hex;
}

function optionalAddressInput(value: string, label: string): Hex | undefined {
  const trimmed = value.trim();
  return trimmed ? addressInput(trimmed, label) : undefined;
}

function blockInput(value: string, label: string): bigint {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${label} is required`);
  try {
    return BigInt(trimmed);
  } catch {
    throw new Error(`${label} must be a decimal or 0x block number`);
  }
}

function bytes32ToText(value: Hex): string {
  const bytes = value.slice(2).match(/.{1,2}/g) ?? [];
  const chars = bytes.map((byte) => Number.parseInt(byte, 16)).filter((code) => code !== 0);
  return String.fromCharCode(...chars);
}

function renderTokenOptions(): void {
  const selectedChainId = currentChainIdOrNull();
  // Show only tokens for the selected chain; fall back to all when the chain is
  // unknown (e.g. a custom chain ID with no presets) so the selects stay usable.
  const chainTokens =
    selectedChainId == null
      ? state.tokens
      : state.tokens.filter((token) => token.chainId === selectedChainId);
  const tokens = chainTokens.length > 0 ? chainTokens : state.tokens;

  const options = tokens
    .map(
      (token) =>
        `<option value="${token.address}">${token.symbol} / ${token.name} / ${shorten(
          token.address,
        )} / ${token.decimals} / ${token.source}</option>`,
    )
    .join("");
  els.sellPreset.innerHTML = options;
  els.buyPreset.innerHTML = options;

  const defaults = selectedChainId == null ? undefined : DEFAULT_PAIR_BY_CHAIN_ID[selectedChainId];
  selectBySymbol(els.sellPreset, defaults?.sell ?? tokens[0]?.symbol);
  selectBySymbol(els.buyPreset, defaults?.buy ?? tokens[1]?.symbol ?? tokens[0]?.symbol);
  applyPreset("sell");
  applyPreset("buy");
}

function selectBySymbol(select: HTMLSelectElement, symbol: string | undefined): void {
  if (!symbol) return;
  const token = state.tokens.find((candidate) => candidate.symbol === symbol);
  if (token) select.value = token.address;
}

function applyPreset(side: "sell" | "buy"): void {
  const select = side === "sell" ? els.sellPreset : els.buyPreset;
  const token = state.tokens.find((candidate) => candidate.address === select.value);
  if (!token) return;
  if (side === "sell") {
    els.sellToken.value = token.address;
    els.sellDecimals.value = String(token.decimals);
  } else {
    els.buyToken.value = token.address;
  }
}

function renderQuoteOptions(): void {
  const response = state.quoteResponse;
  if (!response || response.all.length === 0) {
    els.quoteSelect.innerHTML = `<option value="">fetch quotes first</option>`;
    els.quoteSelect.disabled = true;
    return;
  }

  els.quoteSelect.innerHTML = response.all
    .map((quote, index) => {
      const summary = quoteSummary(quote);
      const forced = els.preferredVenue.value.trim();
      const marker =
        quote.venue === forced
          ? "forced"
          : quote.venue === response.recommended
            ? "recommended"
            : "available";
      return `<option value="${index}">${quote.venue} / ${summary.buyAmount} / ${marker}</option>`;
    })
    .join("");
  const selectedIndex = response.all.findIndex((quote) => quote === state.selectedQuote);
  els.quoteSelect.value = String(selectedIndex >= 0 ? selectedIndex : 0);
  els.quoteSelect.disabled = false;
}

function selectCurrentQuote(): void {
  if (!state.quoteResponse) return;
  const index = Number(els.quoteSelect.value);
  const quote = state.quoteResponse.all[index];
  if (!quote) return;

  state.selectedQuote = quote;
  state.signedQuote = null;
  state.submitResponse = null;
  state.statusResponse = null;
  els.sign.disabled = false;
  els.submit.disabled = true;
  els.poll.disabled = true;

  renderQuoteDetails(quote);
  setJson(els.quoteResponseOut, state.quoteResponse);
  setJson(els.signedOut, {});
  setJson(els.statusOut, {});
  setStatus(`selected ${quote.venue} quote`);
}

function renderQuoteDetails(quote: FirmQuote | null): void {
  if (!state.quoteResponse) {
    setDetails(els.quoteDetailsOut, [
      "Fetch a quote to see the selected venue, human-readable amounts, and signing tasks.",
    ]);
    return;
  }

  setDetails(els.quoteDetailsOut, [
    `Recommended venue: ${state.quoteResponse.recommended}`,
    `Selected quote: ${quote ? formatAmountSummary(quoteSummary(quote)) : "none"}`,
    `Signing tasks: ${
      quote
        ? getQuoteSigningTasks(quote)
            .map((task) => task.kind)
            .join(", ") || "none"
        : "none"
    }`,
    `Available venues: ${state.quoteResponse.all.map((candidate) => candidate.venue).join(", ") || "none"}`,
    `Errors: ${state.quoteResponse.errors?.length ?? 0}`,
  ]);
}

function quoteSummary(quote: FirmQuote): Record<string, unknown> {
  return amountSummary(quote);
}

function priceSummary(price: NormalizedPrice): Record<string, unknown> {
  return amountSummary(price);
}

function amountSummary(value: {
  venue: string;
  sellAmount: string;
  buyAmount: string;
  fees?: unknown[];
}): Record<string, unknown> {
  const sellToken = state.tokens.find(
    (token) => token.address.toLowerCase() === els.sellToken.value.toLowerCase(),
  );
  const buyToken = state.tokens.find(
    (token) => token.address.toLowerCase() === els.buyToken.value.toLowerCase(),
  );
  return {
    venue: value.venue,
    sellAmount: sellToken
      ? `${formatUnits(BigInt(value.sellAmount), sellToken.decimals)} ${sellToken.symbol}`
      : value.sellAmount,
    buyAmount: buyToken
      ? `${formatUnits(BigInt(value.buyAmount), buyToken.decimals)} ${buyToken.symbol}`
      : value.buyAmount,
    fees: value.fees ?? [],
  };
}

function formatAmountSummary(summary: Record<string, unknown>): string {
  const fees = Array.isArray(summary.fees) ? summary.fees.length : 0;
  return `${summary.venue} / sell ${summary.sellAmount} / buy ${summary.buyAmount} / fees ${fees}`;
}

function setDetails(target: HTMLElement, lines: string[]): void {
  target.replaceChildren(
    ...lines.map((line) => {
      const item = document.createElement("div");
      item.textContent = line;
      return item;
    }),
  );
  target.dataset.copyText = lines.join("\n");
}

function setJson(target: HTMLElement, value: unknown): void {
  const text = JSON.stringify(value, bigintJson, 2);
  target.dataset.copyText = text;
  target.replaceChildren(renderJsonValue(value));
}

function renderJsonValue(value: unknown, depth = 0): HTMLElement {
  if (Array.isArray(value)) return renderJsonCollection(value, depth);
  if (value && typeof value === "object")
    return renderJsonCollection(value as Record<string, unknown>, depth);

  const primitive = document.createElement("span");
  primitive.className = `json-primitive ${jsonPrimitiveClass(value)}`;
  primitive.textContent = value === undefined ? "undefined" : JSON.stringify(value, bigintJson);
  return primitive;
}

function renderJsonCollection(
  value: Record<string, unknown> | unknown[],
  depth: number,
): HTMLElement {
  const entries = Array.isArray(value)
    ? value.map((entry, index) => [String(index), entry] as const)
    : Object.entries(value);
  const isArray = Array.isArray(value);
  const node = document.createElement("details");
  node.className = "json-node";
  node.open = true;

  const summary = document.createElement("summary");
  summary.innerHTML = `<span class="json-brace">${entries.length === 0 ? (isArray ? "[]" : "{}") : isArray ? "[" : "{"}</span>`;
  node.append(summary);
  if (entries.length === 0) return node;

  const children = document.createElement("div");
  children.className = "json-children";
  for (const [key, entry] of entries) {
    const row = document.createElement("div");
    row.className = "json-row";

    const keyElement = document.createElement("span");
    keyElement.className = "json-key";
    keyElement.textContent = isArray ? `${key}:` : `"${key}":`;

    row.append(keyElement, renderJsonValue(entry, depth + 1));
    children.append(row);
  }
  node.append(children);

  const close = document.createElement("div");
  close.className = "json-close json-brace";
  close.textContent = isArray ? "]" : "}";
  node.append(close);
  return node;
}

function jsonPrimitiveClass(value: unknown): string {
  if (value === null) return "json-null";
  switch (typeof value) {
    case "string":
      return "json-string";
    case "number":
    case "bigint":
      return "json-number";
    case "boolean":
      return "json-boolean";
    default:
      return "json-null";
  }
}

async function copyOutput(button: HTMLButtonElement): Promise<void> {
  const targetId = button.dataset.copyTarget;
  const target = targetId ? document.getElementById(targetId) : null;
  const text = target?.dataset.copyText ?? target?.textContent ?? "";
  if (!text) return;

  await navigator.clipboard.writeText(text);
  const previous = button.textContent;
  button.textContent = "Copied";
  setTimeout(() => {
    button.textContent = previous;
  }, 1200);
}

function bigintJson(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

function setStatus(text: string, tone: "status" | "error" = "status"): void {
  els.runStatus.textContent = text;
  els.runStatus.className = `pill ${tone}`;
}

async function ensureRouterChain(): Promise<void> {
  const expected = chainId();
  const health = await client().health();
  els.health.textContent = `router ok / chain ${health.chainId}`;
  assertExpectedChain(health.chainId, "router");
  if (health.chainId !== expected) {
    throw new Error(`router chain ${health.chainId} does not match selected chain ${expected}`);
  }
}

async function ensureWalletChain(): Promise<void> {
  const expected = chainId();
  const walletChainId = await currentWalletChainId();
  state.walletChainId = walletChainId;
  els.walletChain.textContent = `chain ${walletChainId}`;
  if (walletChainId !== expected) {
    throw new Error(`wallet chain ${walletChainId} does not match selected chain ${expected}`);
  }
}

async function currentWalletChainId(): Promise<number> {
  if (!window.ethereum) throw new Error("No injected wallet");
  const raw = await window.ethereum.request({ method: "eth_chainId" });
  if (typeof raw !== "string") throw new Error("Wallet returned invalid eth_chainId");
  return Number.parseInt(raw, 16);
}

function assertExpectedChain(actual: number, label: string): void {
  if (actual !== chainId())
    throw new Error(`${label} chain ${actual} != selected chain ${chainId()}`);
}

async function runAction(
  label: string,
  action: () => Promise<void>,
  options: { quiet?: boolean; utility?: boolean } = {},
): Promise<void> {
  try {
    if (!options.quiet) setStatus(`${label}...`);
    await action();
  } catch (error) {
    const details = errorDetails(error);
    setStatus(`${label} failed: ${details.message}`, "error");
    const payload = {
      action: label,
      error: details,
      timestamp: new Date().toISOString(),
    };
    setJson(options.utility ? els.utilityOut : els.statusOut, payload);
  }
}

function must<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element #${id}`);
  return element as T;
}

function shorten(value: string): string {
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorDetails(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) return { message: String(error) };
  const details: Record<string, unknown> = {
    name: error.name,
    message: error.message,
  };
  if ("status" in error) details.status = (error as { status?: unknown }).status;
  if ("body" in error) details.body = (error as { body?: unknown }).body;
  return details;
}

function extractTxHash(value: unknown): Hex {
  const txHash = objectValue(value, ["txHash"]);
  if (typeof txHash === "string" && /^0x[0-9a-fA-F]{64}$/.test(txHash)) {
    return txHash as Hex;
  }
  throw new Error("submit response did not include txHash");
}

function objectValue(value: unknown, path: string[]): unknown {
  let current = value;
  for (const key of path) {
    if (!current || typeof current !== "object" || !(key in current)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}
