package arcusspot

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/ethereum/go-ethereum/common"
)

func newTestRouter(t *testing.T, handler http.Handler) (*SpotRouterClient, *httptest.Server) {
	t.Helper()
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	// Pass the versioned form to exercise base URL normalization.
	client, err := NewSpotRouterClient(ClientOptions{BaseURL: server.URL + "/v1/"})
	if err != nil {
		t.Fatal(err)
	}
	return client, server
}

func TestClientURLNormalization(t *testing.T) {
	for _, baseURL := range []string{"http://example.test", "http://example.test/", "http://example.test/v1", "http://example.test/v1/"} {
		client, err := NewSpotRouterClient(ClientOptions{BaseURL: baseURL})
		if err != nil {
			t.Fatalf("%s: %v", baseURL, err)
		}
		if client.BaseURL != "http://example.test" {
			t.Errorf("%s: BaseURL got %s", baseURL, client.BaseURL)
		}
		if client.apiBaseURL != "http://example.test/v1" {
			t.Errorf("%s: apiBaseURL got %s", baseURL, client.apiBaseURL)
		}
	}

	client, err := NewSpotRouterClient(ClientOptions{BaseURL: "http://example.test/router/v1?x=1#y"})
	if err != nil {
		t.Fatal(err)
	}
	if client.BaseURL != "http://example.test/router" {
		t.Errorf("nested path BaseURL got %s", client.BaseURL)
	}
	if client.apiBaseURL != "http://example.test/router/v1" {
		t.Errorf("nested path apiBaseURL got %s", client.apiBaseURL)
	}

	if _, err := NewSpotRouterClient(ClientOptions{BaseURL: "not a url"}); err == nil {
		t.Error("expected error for invalid base URL")
	}
}

func TestClientHealthIsUnversioned(t *testing.T) {
	client, _ := newTestRouter(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/health" {
			t.Errorf("health path: got %s, want /health", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true,"chainId":4663}`))
	}))

	health, err := client.Health(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !health.OK || health.ChainID != 4663 {
		t.Errorf("unexpected health response: %+v", health)
	}
}

func TestClientGetQuote(t *testing.T) {
	taker := common.HexToAddress("0x00000000000000000000000000000000000000AA")
	client, _ := newTestRouter(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/quote" {
			t.Errorf("quote path: got %s, want /v1/quote", r.URL.Path)
		}
		query := r.URL.Query()
		for key, want := range map[string]string{
			"chainId":      "46630",
			"sellToken":    "0xSELL",
			"buyToken":     "0xBUY",
			"sellAmount":   "10000000",
			"taker":        taker.Hex(),
			"slippageBps":  "50",
			"allowWrapped": "true",
		} {
			if got := query.Get(key); got != want {
				t.Errorf("query %s: got %q, want %q", key, got, want)
			}
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"recommended": "arcus",
			"all": [
				{"venue":"arcus","buyAmount":"123","sellAmount":"10000000","fees":[],"expiry":1755000000,
				 "toSign":{"domain":{"name":"Permit2","chainId":46630},"types":{},"primaryType":"PermitWitnessTransferFrom","message":{"witness":{"taker":"0x00000000000000000000000000000000000000aa"}}},
				 "arcus":{"minAmountOut":"120"}},
				{"venue":"some-future-venue","buyAmount":"1"}
			],
			"errors": [{"venue":"lifi","error":{"kind":"http_5xx","status":502,"message":"boom"}}]
		}`))
	}))

	slippage := 50
	quotes, err := client.GetQuote(context.Background(), QuoteRequest{
		PriceRequest: PriceRequest{
			ChainID:    46630,
			SellToken:  "0xSELL",
			BuyToken:   "0xBUY",
			SellAmount: "10000000",
		},
		Taker:        taker,
		SlippageBps:  &slippage,
		AllowWrapped: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if quotes.Recommended != VenueArcus {
		t.Errorf("recommended: got %s", quotes.Recommended)
	}
	if len(quotes.All) != 1 {
		t.Fatalf("expected 1 known-venue quote (unknown skipped), got %d", len(quotes.All))
	}
	arcus, ok := quotes.All[0].(*ArcusFirmQuote)
	if !ok {
		t.Fatalf("expected *ArcusFirmQuote, got %T", quotes.All[0])
	}
	if arcus.Arcus.MinAmountOut != "120" {
		t.Errorf("minAmountOut: got %s", arcus.Arcus.MinAmountOut)
	}
	if got := arcus.ToSign.Domain.ChainID.Int().Int64(); got != 46630 {
		t.Errorf("toSign chainId: got %d", got)
	}
	if len(quotes.Errors) != 1 || quotes.Errors[0].Venue != VenueLifi || quotes.Errors[0].Error.Status != 502 {
		t.Errorf("unexpected errors: %+v", quotes.Errors)
	}
}

func TestClientTokenList404(t *testing.T) {
	client, _ := newTestRouter(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, `{"error":"not_found"}`, http.StatusNotFound)
	}))

	tokens, err := client.GetTokenList(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(tokens) != 0 {
		t.Errorf("expected empty token list on 404, got %d entries", len(tokens))
	}
}

func TestClientErrorMessageParsing(t *testing.T) {
	client, _ := newTestRouter(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadGateway)
		_, _ = w.Write([]byte(`{"error":"quote_failed","detail":{"message":"{\"name\":\"UpstreamError\",\"message\":\"boom\"}"}}`))
	}))

	_, err := client.GetStatus(context.Background(), StatusRequest{Venue: VenueArcus, ID: "0xabc"})
	var routerErr *SpotRouterError
	if !asSpotRouterError(err, &routerErr) {
		t.Fatalf("expected SpotRouterError, got %v", err)
	}
	if routerErr.Status != http.StatusBadGateway {
		t.Errorf("status: got %d", routerErr.Status)
	}
	if routerErr.Message != "quote_failed: UpstreamError: boom" {
		t.Errorf("message: got %q, want %q", routerErr.Message, "quote_failed: UpstreamError: boom")
	}
}

func TestClientVenueDetailsErrorParsing(t *testing.T) {
	client, _ := newTestRouter(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"code":"all_venues_failed","details":[{"venue":"arcus","error":{"message":"no makers"}},{"venue":"lifi","error":{"message":"boom"}}]}`))
	}))

	_, err := client.GetPrice(context.Background(), PriceRequest{SellToken: "a", BuyToken: "b", SellAmount: "1"})
	var routerErr *SpotRouterError
	if !asSpotRouterError(err, &routerErr) {
		t.Fatalf("expected SpotRouterError, got %v", err)
	}
	want := "all_venues_failed: arcus: no makers; lifi: boom"
	if routerErr.Message != want {
		t.Errorf("message: got %q, want %q", routerErr.Message, want)
	}
}

func TestClientSendsAPIKey(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("X-Api-Key"); got != "arc_test" {
			t.Errorf("X-Api-Key: got %q", got)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`[]`))
	}))
	t.Cleanup(server.Close)
	client, err := NewSpotRouterClient(ClientOptions{BaseURL: server.URL + "/v1", APIKey: "arc_test"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := client.GetTokenList(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func TestClientForwardsBuilderFeeBps(t *testing.T) {
	bps := 80
	client, _ := newTestRouter(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.URL.Query().Get("builderFeeBps"); got != "80" {
			t.Errorf("builderFeeBps: got %q", got)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"recommended":"arcus","venue":"arcus","details":{"paths":[]},"all":[]}`))
	}))
	if _, err := client.GetPrice(context.Background(), PriceRequest{
		SellToken:     "0x1",
		BuyToken:      "0x2",
		SellAmount:    "1",
		BuilderFeeBps: &bps,
	}); err != nil {
		t.Fatal(err)
	}
}
