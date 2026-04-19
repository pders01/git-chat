import { describe, expect, test } from "bun:test";
import {
  formatSources,
  providerSources,
  isProviderAvailable,
  hostOf,
  isLocalhostURL,
  findModelPricing,
  estimateTokensFromChars,
  estimateCostUsd,
  type AvailabilityContext,
} from "./catalog.js";
import type { CatalogProvider } from "../gen/gitchat/v1/repo_pb.js";

describe("formatSources", () => {
  test("returns empty string for missing input", () => {
    expect(formatSources(undefined)).toBe("");
    expect(formatSources([])).toBe("");
  });

  test("single source renders as the id itself", () => {
    expect(formatSources(["catwalk"])).toBe("catwalk");
  });

  test("multi-source renders joined with +", () => {
    expect(formatSources(["catwalk", "openrouter"])).toBe("catwalk+openrouter");
    expect(formatSources(["catwalk", "openrouter", "models-dev"])).toBe(
      "catwalk+openrouter+models-dev",
    );
  });

  test("preserves caller's source order (merge order matters)", () => {
    // The merge orchestrator controls source order (registration order
    // for tiebreaks). Downstream display respects that ordering so
    // "catwalk+openrouter" stays stable across refreshes.
    expect(formatSources(["openrouter", "catwalk"])).toBe("openrouter+catwalk");
  });
});

// Minimal shape — proto types are noisy but we only need `models` here.
function prov(models: Array<{ sources?: string[] }>): CatalogProvider {
  return { models } as unknown as CatalogProvider;
}

describe("providerSources", () => {
  test("empty models → empty list", () => {
    expect(providerSources(prov([]))).toEqual([]);
  });

  test("single model's sources become the provider's list", () => {
    expect(providerSources(prov([{ sources: ["catwalk"] }]))).toEqual(["catwalk"]);
  });

  test("dedups across models, preserves first-seen order", () => {
    const p = prov([
      { sources: ["catwalk", "openrouter"] },
      { sources: ["models-dev", "catwalk"] },
    ]);
    expect(providerSources(p)).toEqual(["catwalk", "openrouter", "models-dev"]);
  });

  test("tolerates missing sources field on a model", () => {
    expect(providerSources(prov([{}, { sources: ["catwalk"] }]))).toEqual(["catwalk"]);
  });
});

// Test helpers for availability scenarios.
function mkProvider(
  type: string,
  defaultBaseUrl: string,
  id = "test-id",
): CatalogProvider {
  return { id, name: id, type, defaultBaseUrl, models: [] } as unknown as CatalogProvider;
}

function ctxEmpty(): AvailabilityContext {
  return {
    localUrls: [],
    profileBaseUrls: [],
    profileBackends: [],
    configBaseUrl: "",
    configBackend: "openai",
    configHasKey: false,
  };
}

describe("isProviderAvailable", () => {
  test("no routes → nothing is available", () => {
    const fw = mkProvider("openai", "https://api.fireworks.ai/inference/v1");
    expect(isProviderAvailable(fw, ctxEmpty())).toBe(false);
  });

  test("local endpoint URL matches → callable (no key needed)", () => {
    const lm = mkProvider("openai", "http://localhost:1234/v1");
    const ctx = { ...ctxEmpty(), localUrls: ["http://localhost:1234/v1"] };
    expect(isProviderAvailable(lm, ctx)).toBe(true);
  });

  test("profile base URL matches → callable (profile has its own key)", () => {
    const fw = mkProvider("openai", "https://api.fireworks.ai/inference/v1");
    const ctx = {
      ...ctxEmpty(),
      profileBaseUrls: ["https://api.fireworks.ai/inference/v1"],
    };
    expect(isProviderAvailable(fw, ctx)).toBe(true);
  });

  test("LLM_BASE_URL matches + key set → callable", () => {
    const fw = mkProvider("openai", "https://api.fireworks.ai/inference/v1");
    const ctx = {
      ...ctxEmpty(),
      configBaseUrl: "https://api.fireworks.ai/inference/v1",
      configHasKey: true,
    };
    expect(isProviderAvailable(fw, ctx)).toBe(true);
  });

  test("LLM_BASE_URL matches but key missing → NOT callable (prevents key leak to wrong provider)", () => {
    const fw = mkProvider("openai", "https://api.fireworks.ai/inference/v1");
    const ctx = {
      ...ctxEmpty(),
      configBaseUrl: "https://api.fireworks.ai/inference/v1",
      configHasKey: false,
    };
    expect(isProviderAvailable(fw, ctx)).toBe(false);
  });

  test("localhost URL without key is callable (local dev exception)", () => {
    const lm = mkProvider("openai", "http://localhost:1234/v1");
    const ctx = {
      ...ctxEmpty(),
      configBaseUrl: "http://localhost:1234/v1",
      configHasKey: false,
    };
    expect(isProviderAvailable(lm, ctx)).toBe(true);
  });

  test("URL normalization ignores trailing slash + case", () => {
    const fw = mkProvider("openai", "https://API.fireworks.AI/inference/v1");
    const ctx = {
      ...ctxEmpty(),
      configBaseUrl: "https://api.fireworks.ai/inference/v1/",
      configHasKey: true,
    };
    expect(isProviderAvailable(fw, ctx)).toBe(true);
  });

  test("anthropic-type: available only when anthropic backend is reachable", () => {
    const claude = mkProvider("anthropic", "");
    expect(isProviderAvailable(claude, ctxEmpty())).toBe(false);

    // Profile with anthropic backend unlocks it
    expect(
      isProviderAvailable(claude, { ...ctxEmpty(), profileBackends: ["anthropic"] }),
    ).toBe(true);

    // Or config with anthropic backend + key
    expect(
      isProviderAvailable(claude, {
        ...ctxEmpty(),
        configBackend: "anthropic",
        configHasKey: true,
      }),
    ).toBe(true);

    // anthropic backend without key → not available
    expect(
      isProviderAvailable(claude, { ...ctxEmpty(), configBackend: "anthropic" }),
    ).toBe(false);
  });

  test("openai-type provider is NOT unlocked just because anthropic is available", () => {
    const openai = mkProvider("openai", "https://api.openai.com/v1");
    const ctx = { ...ctxEmpty(), profileBackends: ["anthropic"] };
    expect(isProviderAvailable(openai, ctx)).toBe(false);
  });

  test("provider without defaultBaseUrl (openai-type) is not callable", () => {
    const ghost = mkProvider("openai", "");
    const ctx = { ...ctxEmpty(), configHasKey: true };
    expect(isProviderAvailable(ghost, ctx)).toBe(false);
  });
});

describe("hostOf", () => {
  test("extracts hostname without port", () => {
    expect(hostOf("https://api.fireworks.ai/inference/v1")).toBe("api.fireworks.ai");
    expect(hostOf("http://localhost:1234/v1")).toBe("localhost");
  });

  test("lowercases the hostname (URL spec says hostname is case-insensitive)", () => {
    expect(hostOf("https://API.Fireworks.ai/inference/v1")).toBe("api.fireworks.ai");
  });

  test("returns empty for blank or malformed input", () => {
    expect(hostOf("")).toBe("");
    expect(hostOf("not a url")).toBe("");
    expect(hostOf("//missing-scheme.com")).toBe("");
  });
});

describe("isLocalhostURL", () => {
  test.each([
    ["http://localhost:1234/v1", true],
    ["http://127.0.0.1:11434", true],
    ["http://[::1]:8080", true],
    ["https://api.openai.com/v1", false],
    ["http://example.com", false],
    ["", false],
  ])("%s → %s", (input, expected) => {
    expect(isLocalhostURL(input)).toBe(expected);
  });
});

describe("findModelPricing", () => {
  function catalogWith(models: Array<{ id: string; in: number; out: number }>): CatalogProvider[] {
    return [
      {
        models: models.map((m) => ({
          id: m.id,
          costPer1mIn: m.in,
          costPer1mOut: m.out,
        })),
      } as unknown as CatalogProvider,
    ];
  }

  test("returns pricing when model exists", () => {
    const cat = catalogWith([{ id: "gpt-4o", in: 2.5, out: 10 }]);
    expect(findModelPricing("gpt-4o", cat)).toEqual({ in: 2.5, out: 10 });
  });

  test("returns null when model isn't in catalog", () => {
    const cat = catalogWith([{ id: "gpt-4o", in: 2.5, out: 10 }]);
    expect(findModelPricing("missing-model", cat)).toBeNull();
  });

  test("returns null for empty catalog", () => {
    expect(findModelPricing("anything", [])).toBeNull();
  });
});

describe("estimateTokensFromChars", () => {
  test("4-chars-per-token heuristic", () => {
    expect(estimateTokensFromChars(0)).toBe(0);
    expect(estimateTokensFromChars(4)).toBe(1);
    expect(estimateTokensFromChars(15)).toBe(4); // ceil(15/4) = 4
  });
});

describe("estimateCostUsd", () => {
  test("computes cost from tokens + pricing", () => {
    // 10K in @ $2.5/M + 5K out @ $10/M = 0.025 + 0.05 = 0.075
    expect(estimateCostUsd(10_000, 5_000, { in: 2.5, out: 10 })).toBeCloseTo(0.075);
  });

  test("returns 0 when pricing is null", () => {
    expect(estimateCostUsd(1000, 1000, null)).toBe(0);
  });

  test("free models (0/0) return 0", () => {
    expect(estimateCostUsd(10000, 5000, { in: 0, out: 0 })).toBe(0);
  });
});
