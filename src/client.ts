import type {
  ClientOptions,
  PriceRequest,
  PriceResponse,
  QuoteRequest,
  QuoteResponse,
  SignedQuote,
  StatusRequest,
  StatusResponse,
  SubmitResponse,
  TokenInfo,
} from "./types.js";

export class SpotRouterError extends Error {
  readonly status: number | undefined;
  readonly body: unknown;

  constructor(message: string, options: { status?: number; body?: unknown } = {}) {
    super(message);
    this.name = "SpotRouterError";
    this.status = options.status;
    this.body = options.body;
  }
}

// Narrower than RequestInit so headers stay a plain record the client can merge
// the API key into.
type JsonRequestInit = Omit<RequestInit, "headers"> & { headers?: Record<string, string> };

export class SpotRouterClient {
  readonly baseUrl: string;
  private readonly apiBaseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;
  private readonly apiKey: string | undefined;

  constructor(options: ClientOptions) {
    this.baseUrl = withoutApiVersion(options.baseUrl.replace(/\/+$/, ""));
    this.apiBaseUrl = withApiVersion(this.baseUrl);
    const defaultFetch = globalThis.fetch?.bind(globalThis);
    this.fetchFn = options.fetch ?? defaultFetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.apiKey = options.apiKey;

    if (!this.fetchFn) {
      throw new SpotRouterError("No fetch implementation available");
    }
  }

  async health(): Promise<{ ok: boolean; chainId: number }> {
    return this.getJson("/health", { versioned: false });
  }

  async getPrice(request: PriceRequest): Promise<PriceResponse> {
    const url = this.url("/price", request);
    return this.getJson(url);
  }

  async getQuote(request: QuoteRequest): Promise<QuoteResponse> {
    const url = this.url("/quote", {
      ...request,
      slippageBps: request.slippageBps == null ? undefined : String(request.slippageBps),
      allowWrapped: request.allowWrapped ? "true" : undefined,
    });
    return this.getJson(url);
  }

  async submitSignedQuote(signedQuote: SignedQuote): Promise<SubmitResponse> {
    return this.postJson("/submit", signedQuote);
  }

  async getStatus(request: StatusRequest): Promise<StatusResponse> {
    return this.getJson(this.url("/status", request));
  }

  async getTokenList(): Promise<TokenInfo[]> {
    try {
      return await this.getJson("/tokens");
    } catch (error) {
      if (error instanceof SpotRouterError && error.status === 404) return [];
      throw error;
    }
  }

  private url(path: string, params: Record<string, string | number | undefined>): URL {
    const url = new URL(relativePath(path), `${this.apiBaseUrl}/`);
    for (const [key, value] of Object.entries(params)) {
      if (value != null) url.searchParams.set(key, String(value));
    }
    return url;
  }

  private async getJson<T>(
    pathOrUrl: string | URL,
    options: { versioned?: boolean } = {},
  ): Promise<T> {
    return this.requestJson<T>(
      pathOrUrl,
      { method: "GET" },
      options.versioned === false ? this.baseUrl : this.apiBaseUrl,
    );
  }

  private async postJson<T>(path: string, body: unknown): Promise<T> {
    return this.requestJson<T>(
      path,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
      this.apiBaseUrl,
    );
  }

  private async requestJson<T>(
    pathOrUrl: string | URL,
    init: JsonRequestInit,
    baseUrl: string,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const url =
      typeof pathOrUrl === "string" ? new URL(relativePath(pathOrUrl), `${baseUrl}/`) : pathOrUrl;

    let response: Response;
    try {
      response = await this.fetchFn(url, {
        ...init,
        headers: {
          ...init.headers,
          ...(this.apiKey ? { "X-Api-Key": this.apiKey } : {}),
        },
        signal: controller.signal,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new SpotRouterError(`Router request failed: ${message}`);
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text();
    const body = text ? parseJson(text) : null;

    if (!response.ok) {
      const message = routerErrorMessage(body) ?? `Router request failed with ${response.status}`;
      throw new SpotRouterError(message, { status: response.status, body });
    }

    return body as T;
  }
}

function withApiVersion(baseUrl: string): string {
  const url = new URL(baseUrl);
  const pathParts = url.pathname.split("/").filter(Boolean);
  if (pathParts[pathParts.length - 1] !== "v1") {
    url.pathname = `/${[...pathParts, "v1"].join("/")}`;
  }
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/+$/, "");
}

function withoutApiVersion(baseUrl: string): string {
  const url = new URL(baseUrl);
  const pathParts = url.pathname.split("/").filter(Boolean);
  if (pathParts[pathParts.length - 1] === "v1") {
    pathParts.pop();
    url.pathname = pathParts.length === 0 ? "/" : `/${pathParts.join("/")}`;
  }
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/+$/, "");
}

function relativePath(path: string): string {
  return path.replace(/^\/+/, "");
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function routerErrorMessage(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const error = "error" in body ? String((body as { error: unknown }).error) : undefined;
  const code = "code" in body ? String((body as { code: unknown }).code) : undefined;
  const detail = "detail" in body ? (body as { detail?: unknown }).detail : undefined;
  const details = "details" in body ? (body as { details?: unknown }).details : undefined;
  const detailMessage =
    detail && typeof detail === "object" && "message" in detail
      ? parseNestedMessage(String((detail as { message: unknown }).message))
      : undefined;
  const detailsMessage = Array.isArray(details)
    ? details
        .map((item) => {
          if (!item || typeof item !== "object") return undefined;
          const venue = "venue" in item ? String((item as { venue: unknown }).venue) : "upstream";
          const upstreamError = (item as { error?: unknown }).error;
          if (!upstreamError || typeof upstreamError !== "object") return venue;
          const message =
            "message" in upstreamError
              ? String((upstreamError as { message: unknown }).message)
              : undefined;
          return message ? `${venue}: ${parseNestedMessage(message)}` : venue;
        })
        .filter(Boolean)
        .join("; ")
    : undefined;

  if (error && detailMessage) return `${error}: ${detailMessage}`;
  if (code && detailsMessage) return `${code}: ${detailsMessage}`;
  if (code) return code;
  return error;
}

function parseNestedMessage(message: string): string {
  const parsed = parseJson(message);
  if (parsed && typeof parsed === "object") {
    const name = "name" in parsed ? String((parsed as { name: unknown }).name) : undefined;
    const nestedMessage =
      "message" in parsed ? String((parsed as { message: unknown }).message) : undefined;
    if (name && nestedMessage) return `${name}: ${nestedMessage}`;
    if (nestedMessage) return nestedMessage;
  }
  return message;
}
