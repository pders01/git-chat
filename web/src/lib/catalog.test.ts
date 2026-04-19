import { describe, expect, test } from "bun:test";
import { formatSources, providerSources } from "./catalog.js";
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
