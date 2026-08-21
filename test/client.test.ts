import { describe, expect, test } from "bun:test";
import { SpotRouterClient } from "../src/client.js";

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
