package arcusspot

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// DefaultTimeout is the per-request timeout when ClientOptions.Timeout is zero.
const DefaultTimeout = 15 * time.Second

// ClientOptions configures a SpotRouterClient.
type ClientOptions struct {
	// BaseURL is the router base URL, with or without the /v1 suffix
	// (e.g. "https://router.spot.arcus.xyz/v1" or "http://localhost:8787").
	BaseURL string
	// HTTPClient overrides the HTTP client; defaults to http.DefaultClient.
	HTTPClient *http.Client
	// Timeout bounds each request; defaults to DefaultTimeout.
	Timeout time.Duration
	// APIKey is sent as X-Api-Key on every request.
	APIKey string
}

// SpotRouterError is returned for failed router requests. Status is zero for
// transport-level failures (no HTTP response).
type SpotRouterError struct {
	Message   string
	Status    int
	Body      any
	Method    string
	URL       string
	Timeout   time.Duration
	Cause     error
}

// Error implements error.
func (e *SpotRouterError) Error() string { return e.Message }

// Unwrap returns the underlying transport cause, if any.
func (e *SpotRouterError) Unwrap() error { return e.Cause }

// SpotRouterClient talks to the spot router HTTP API. All endpoints except
// Health live under /v1; the client normalizes BaseURL either way.
type SpotRouterClient struct {
	// BaseURL is the normalized base URL without the /v1 suffix.
	BaseURL string

	apiBaseURL string
	httpClient *http.Client
	timeout    time.Duration
	apiKey     string
}

// NewSpotRouterClient validates and normalizes options.BaseURL and returns a
// ready client.
func NewSpotRouterClient(options ClientOptions) (*SpotRouterClient, error) {
	trimmed := strings.TrimRight(options.BaseURL, "/")
	baseURL, err := withoutAPIVersion(trimmed)
	if err != nil {
		return nil, &SpotRouterError{Message: fmt.Sprintf("invalid base URL %q: %v", options.BaseURL, err)}
	}
	apiBaseURL, err := withAPIVersion(baseURL)
	if err != nil {
		return nil, &SpotRouterError{Message: fmt.Sprintf("invalid base URL %q: %v", options.BaseURL, err)}
	}
	httpClient := options.HTTPClient
	if httpClient == nil {
		httpClient = http.DefaultClient
	}
	timeout := options.Timeout
	if timeout <= 0 {
		timeout = DefaultTimeout
	}
	return &SpotRouterClient{
		BaseURL:    baseURL,
		apiBaseURL: apiBaseURL,
		httpClient: httpClient,
		timeout:    timeout,
		apiKey:     options.APIKey,
	}, nil
}

// Health calls the unversioned GET /health endpoint.
func (c *SpotRouterClient) Health(ctx context.Context) (*HealthResponse, error) {
	var out HealthResponse
	if err := c.getJSON(ctx, c.BaseURL+"/health", &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// GetPrice calls GET /v1/price.
func (c *SpotRouterClient) GetPrice(ctx context.Context, request PriceRequest) (*PriceResponse, error) {
	params := url.Values{}
	addPriceParams(params, request)
	var out PriceResponse
	if err := c.getJSON(ctx, c.apiBaseURL+"/price?"+params.Encode(), &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// GetQuote calls GET /v1/quote.
func (c *SpotRouterClient) GetQuote(ctx context.Context, request QuoteRequest) (*QuoteResponse, error) {
	params := url.Values{}
	addPriceParams(params, request.PriceRequest)
	params.Set("taker", request.Taker.Hex())
	if request.SlippageBps != nil {
		params.Set("slippageBps", strconv.Itoa(*request.SlippageBps))
	}
	if request.AllowWrapped {
		params.Set("allowWrapped", "true")
	}
	var out QuoteResponse
	if err := c.getJSON(ctx, c.apiBaseURL+"/quote?"+params.Encode(), &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// SubmitSignedQuote calls POST /v1/submit with the signed quote body.
func (c *SpotRouterClient) SubmitSignedQuote(ctx context.Context, signedQuote SignedQuote) (*SubmitResponse, error) {
	body, err := json.Marshal(signedQuote)
	if err != nil {
		return nil, &SpotRouterError{Message: fmt.Sprintf("encode signed quote: %v", err)}
	}
	var out SubmitResponse
	if err := c.requestJSON(ctx, http.MethodPost, c.apiBaseURL+"/submit", body, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// GetStatus calls GET /v1/status.
func (c *SpotRouterClient) GetStatus(ctx context.Context, request StatusRequest) (*StatusResponse, error) {
	params := url.Values{}
	params.Set("venue", string(request.Venue))
	params.Set("id", request.ID)
	if request.ChainID != 0 {
		params.Set("chainId", strconv.FormatUint(request.ChainID, 10))
	}
	var out StatusResponse
	if err := c.getJSON(ctx, c.apiBaseURL+"/status?"+params.Encode(), &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// GetTokenList calls GET /v1/tokens. Routers without the endpoint (404) yield
// an empty list, mirroring the TS SDK.
func (c *SpotRouterClient) GetTokenList(ctx context.Context) ([]TokenInfo, error) {
	var out []TokenInfo
	if err := c.getJSON(ctx, c.apiBaseURL+"/tokens", &out); err != nil {
		var routerErr *SpotRouterError
		if asSpotRouterError(err, &routerErr) && routerErr.Status == http.StatusNotFound {
			return []TokenInfo{}, nil
		}
		return nil, err
	}
	return out, nil
}

func asSpotRouterError(err error, target **SpotRouterError) bool {
	e, ok := err.(*SpotRouterError)
	if ok {
		*target = e
	}
	return ok
}

func addPriceParams(params url.Values, request PriceRequest) {
	if request.ChainID != 0 {
		params.Set("chainId", strconv.FormatUint(request.ChainID, 10))
	}
	params.Set("sellToken", request.SellToken)
	params.Set("buyToken", request.BuyToken)
	params.Set("sellAmount", request.SellAmount)
	if request.BuilderFeeBps != nil {
		params.Set("builderFeeBps", strconv.Itoa(*request.BuilderFeeBps))
	}
}

func (c *SpotRouterClient) getJSON(ctx context.Context, rawURL string, out any) error {
	return c.requestJSON(ctx, http.MethodGet, rawURL, nil, out)
}

func (c *SpotRouterClient) requestJSON(ctx context.Context, method, rawURL string, body []byte, out any) error {
	ctx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()

	var reader io.Reader
	if body != nil {
		reader = bytes.NewReader(body)
	}
	request, err := http.NewRequestWithContext(ctx, method, rawURL, reader)
	if err != nil {
		return &SpotRouterError{
			Message: fmt.Sprintf("Router request failed: %v (%s %s)", err, method, rawURL),
			Method:  method,
			URL:     rawURL,
			Timeout: c.timeout,
			Cause:   err,
		}
	}
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	if c.apiKey != "" {
		request.Header.Set("X-Api-Key", c.apiKey)
	}

	response, err := c.httpClient.Do(request)
	if err != nil {
		reason := err.Error()
		root := ""
		if errors.Is(err, context.DeadlineExceeded) || ctx.Err() == context.DeadlineExceeded {
			reason = fmt.Sprintf("timed out after %s", c.timeout)
			root = fmt.Sprintf(" [%T: %v]", err, err)
		}
		return &SpotRouterError{
			Message: fmt.Sprintf("Router request failed: %s (%s %s)%s", reason, method, rawURL, root),
			Method:  method,
			URL:     rawURL,
			Timeout: c.timeout,
			Cause:   err,
		}
	}
	defer response.Body.Close()

	text, err := io.ReadAll(response.Body)
	if err != nil {
		return &SpotRouterError{
			Message: fmt.Sprintf("Router request failed: %v (%s %s)", err, method, rawURL),
			Method:  method,
			URL:     rawURL,
			Timeout: c.timeout,
			Cause:   err,
		}
	}

	var parsedBody any
	if len(text) > 0 {
		parsedBody = parseJSONOrText(text)
	}

	if response.StatusCode < 200 || response.StatusCode >= 300 {
		message := routerErrorMessage(parsedBody)
		if message == "" {
			message = fmt.Sprintf("Router request failed with %d", response.StatusCode)
		}
		return &SpotRouterError{
			Message: message,
			Status:  response.StatusCode,
			Body:    parsedBody,
			Method:  method,
			URL:     rawURL,
			Timeout: c.timeout,
		}
	}

	if out == nil || len(text) == 0 {
		return nil
	}
	dec := json.NewDecoder(bytes.NewReader(text))
	dec.UseNumber()
	if err := dec.Decode(out); err != nil {
		return &SpotRouterError{
			Message: fmt.Sprintf("Router response decode failed: %v", err),
			Status:  response.StatusCode,
			Body:    parsedBody,
		}
	}
	return nil
}

// withAPIVersion ensures the URL path ends with /v1, dropping query/fragment.
func withAPIVersion(baseURL string) (string, error) {
	parsed, err := url.Parse(baseURL)
	if err != nil {
		return "", err
	}
	parts := splitPath(parsed.Path)
	if len(parts) == 0 || parts[len(parts)-1] != "v1" {
		parts = append(parts, "v1")
	}
	parsed.Path = "/" + strings.Join(parts, "/")
	parsed.RawQuery = ""
	parsed.Fragment = ""
	return strings.TrimRight(parsed.String(), "/"), nil
}

// withoutAPIVersion strips a trailing /v1 path segment, dropping query/fragment.
func withoutAPIVersion(baseURL string) (string, error) {
	parsed, err := url.Parse(baseURL)
	if err != nil {
		return "", err
	}
	if !parsed.IsAbs() {
		return "", fmt.Errorf("base URL must be absolute")
	}
	parts := splitPath(parsed.Path)
	if len(parts) > 0 && parts[len(parts)-1] == "v1" {
		parts = parts[:len(parts)-1]
	}
	if len(parts) == 0 {
		parsed.Path = "/"
	} else {
		parsed.Path = "/" + strings.Join(parts, "/")
	}
	parsed.RawQuery = ""
	parsed.Fragment = ""
	return strings.TrimRight(parsed.String(), "/"), nil
}

func splitPath(path string) []string {
	var parts []string
	for _, part := range strings.Split(path, "/") {
		if part != "" {
			parts = append(parts, part)
		}
	}
	return parts
}

func parseJSONOrText(text []byte) any {
	var parsed any
	dec := json.NewDecoder(bytes.NewReader(text))
	dec.UseNumber()
	if err := dec.Decode(&parsed); err != nil {
		return string(text)
	}
	return parsed
}

// routerErrorMessage extracts a human-readable message from router error
// bodies, mirroring the TS SDK: it combines the top-level "error"/"code" with
// nested "detail.message" or per-venue "details[].error.message" strings.
func routerErrorMessage(body any) string {
	object, ok := body.(map[string]any)
	if !ok {
		return ""
	}
	errorValue := stringField(object, "error")
	code := stringField(object, "code")

	var detailMessage string
	if detail, ok := object["detail"].(map[string]any); ok {
		if message := stringField(detail, "message"); message != "" {
			detailMessage = parseNestedMessage(message)
		}
	}

	var detailsMessage string
	if details, ok := object["details"].([]any); ok {
		var parts []string
		for _, item := range details {
			entry, ok := item.(map[string]any)
			if !ok {
				continue
			}
			venue := stringField(entry, "venue")
			if venue == "" {
				venue = "upstream"
			}
			upstream, ok := entry["error"].(map[string]any)
			if !ok {
				parts = append(parts, venue)
				continue
			}
			message := stringField(upstream, "message")
			if message != "" {
				parts = append(parts, venue+": "+parseNestedMessage(message))
			} else {
				parts = append(parts, venue)
			}
		}
		detailsMessage = strings.Join(parts, "; ")
	}

	switch {
	case errorValue != "" && detailMessage != "":
		return errorValue + ": " + detailMessage
	case code != "" && detailsMessage != "":
		return code + ": " + detailsMessage
	case code != "":
		return code
	default:
		return errorValue
	}
}

// parseNestedMessage unwraps error messages that are themselves JSON documents
// with name/message fields.
func parseNestedMessage(message string) string {
	var parsed map[string]any
	if err := json.Unmarshal([]byte(message), &parsed); err != nil {
		return message
	}
	name := stringField(parsed, "name")
	nested := stringField(parsed, "message")
	switch {
	case name != "" && nested != "":
		return name + ": " + nested
	case nested != "":
		return nested
	default:
		return message
	}
}

func stringField(object map[string]any, key string) string {
	value, ok := object[key]
	if !ok || value == nil {
		return ""
	}
	if s, ok := value.(string); ok {
		return s
	}
	return fmt.Sprintf("%v", value)
}
