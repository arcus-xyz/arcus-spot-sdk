import { describe, expect, test } from "bun:test";
import { SpotRouterClient, SpotRouterError } from "../src";

describe("SpotRouterClient request errors", () => {
  test("includes method, url, and cause when fetch throws", async () => {
    const cause = new TypeError("Failed to fetch");
    const client = new SpotRouterClient({
      baseUrl: "https://router.example",
      timeoutMs: 12_000,
      fetch: async () => {
        throw cause;
      },
    });

    let caught: unknown;
    try {
      await client.health();
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(SpotRouterError);
    const error = caught as SpotRouterError;
    expect(error.message).toBe(
      "Router request failed: Failed to fetch (GET https://router.example/health)",
    );
    expect(error.method).toBe("GET");
    expect(error.url).toBe("https://router.example/health");
    expect(error.timeoutMs).toBe(12_000);
    expect(error.cause).toBe(cause);
  });

  test("reports timeout when the request is aborted", async () => {
    const client = new SpotRouterClient({
      baseUrl: "https://router.example",
      timeoutMs: 5,
      fetch: async (_input, init) => {
        await new Promise<never>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const abortError = new Error("The operation was aborted");
            abortError.name = "AbortError";
            reject(abortError);
          });
        });
      },
    });

    let caught: unknown;
    try {
      await client.getTokenList();
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(SpotRouterError);
    const error = caught as SpotRouterError;
    expect(error.message).toBe(
      "Router request failed: timed out after 5ms (GET https://router.example/v1/tokens) [AbortError: The operation was aborted]",
    );
    expect(error.method).toBe("GET");
    expect(error.url).toBe("https://router.example/v1/tokens");
    expect(error.timeoutMs).toBe(5);
  });

  test("toJSON returns the full structured error", async () => {
    const cause = new TypeError("Failed to fetch");
    const client = new SpotRouterClient({
      baseUrl: "https://router.example",
      timeoutMs: 12_000,
      fetch: async () => {
        throw cause;
      },
    });

    let caught: unknown;
    try {
      await client.health();
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(SpotRouterError);
    const error = caught as SpotRouterError;
    expect(error.toJSON()).toEqual({
      name: "SpotRouterError",
      message: "Router request failed: Failed to fetch (GET https://router.example/health)",
      status: undefined,
      body: undefined,
      method: "GET",
      url: "https://router.example/health",
      timeoutMs: 12_000,
      causeName: "TypeError",
      causeMessage: "Failed to fetch",
    });
    expect(JSON.parse(JSON.stringify(error))).toEqual({
      name: "SpotRouterError",
      message: "Router request failed: Failed to fetch (GET https://router.example/health)",
      method: "GET",
      url: "https://router.example/health",
      timeoutMs: 12_000,
      causeName: "TypeError",
      causeMessage: "Failed to fetch",
    });
  });

  test("toJSON includes http status and body", async () => {
    const client = new SpotRouterClient({
      baseUrl: "https://router.example",
      fetch: async () =>
        new Response(JSON.stringify({ error: "no_route", code: "NO_ROUTE" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        }),
    });

    let caught: unknown;
    try {
      await client.getQuote({
        sellToken: "0x1",
        buyToken: "0x2",
        sellAmount: "1",
        taker: "0x0000000000000000000000000000000000000001",
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(SpotRouterError);
    const error = caught as SpotRouterError;
    expect(error.toJSON()).toEqual({
      name: "SpotRouterError",
      message: "NO_ROUTE",
      status: 404,
      body: { error: "no_route", code: "NO_ROUTE" },
      method: "GET",
      url: "https://router.example/v1/quote?sellToken=0x1&buyToken=0x2&sellAmount=1&taker=0x0000000000000000000000000000000000000001",
      timeoutMs: 15_000,
      causeName: undefined,
      causeMessage: undefined,
    });
  });
});

describe("SpotRouterClient API key", () => {
  function captureHeaders(apiKey?: string) {
    const seen: Array<Record<string, string>> = [];
    const client = new SpotRouterClient({
      baseUrl: "https://router.example",
      ...(apiKey ? { apiKey } : {}),
      fetch: async (_input, init) => {
        seen.push((init?.headers ?? {}) as Record<string, string>);
        return new Response("{}", { headers: { "Content-Type": "application/json" } });
      },
    });
    return { client, seen };
  }

  test("sends X-Api-Key on GET and POST when configured", async () => {
    const { client, seen } = captureHeaders("arc_7f3a2bK9xQmR4vT1nL8sD6wY0hJ5cZpE");

    await client.getTokenList();
    await client.submitSignedQuote({ venue: "arcus" } as never);

    expect(seen).toHaveLength(2);
    expect(seen[0]?.["X-Api-Key"]).toBe("arc_7f3a2bK9xQmR4vT1nL8sD6wY0hJ5cZpE");
    // The POST's own Content-Type must survive the merge.
    expect(seen[1]?.["X-Api-Key"]).toBe("arc_7f3a2bK9xQmR4vT1nL8sD6wY0hJ5cZpE");
    expect(seen[1]?.["Content-Type"]).toBe("application/json");
  });

  test("sends no key header when unconfigured, so an ungated router is unaffected", async () => {
    const { client, seen } = captureHeaders();
    await client.getTokenList();
    expect(seen[0]).not.toHaveProperty("X-Api-Key");
  });
});

describe("SpotRouterClient builderFeeBps", () => {
  test("forwards builderFeeBps on /price and /quote", async () => {
    const urls: string[] = [];
    const client = new SpotRouterClient({
      baseUrl: "https://router.example",
      apiKey: "arc_test",
      fetch: async (input) => {
        urls.push(String(input));
        return new Response("{}", { headers: { "Content-Type": "application/json" } });
      },
    });

    await client.getPrice({
      sellToken: "0x1",
      buyToken: "0x2",
      sellAmount: "1",
      builderFeeBps: 80,
    });
    await client.getQuote({
      sellToken: "0x1",
      buyToken: "0x2",
      sellAmount: "1",
      taker: "0x0000000000000000000000000000000000000001",
      builderFeeBps: 80,
    });

    expect(urls[0]).toContain("builderFeeBps=80");
    expect(urls[1]).toContain("builderFeeBps=80");
  });
});
